#!/usr/bin/env python3
"""
card_cropper_sam.py

Detect and crop a trading card from a photo using SAM (Segment Anything Model)
via HuggingFace transformers, then apply true rotation correction before cropping.

SAM's semantic segmentation works regardless of backdrop colour, making it ideal
for cards with black edges on a black backdrop that defeat classical edge detection.

After detecting the card's boundary:
1. Compute the rotation needed to make the card's edges perfectly horizontal/vertical.
2. Rotate the image (not just crop a tilted rectangle) so printed text reads normally.
3. Crop the axis-aligned bounding box of the now-upright card.

Requires:
    pip install transformers accelerate

Two modes:

1) Persistent worker (default — no CLI args):
   Newline-delimited JSON over stdin/stdout. The 375MB SAM model is loaded
   once at startup and kept warm for the life of the process.
     Request:  {"cmd": "crop", "paths": ["/abs/img1.jpg", ...], "output_dir": "..."}
     Response: [{"success": true, "image_path": "...", "cards": [...]}, ...]
     Special:  {"cmd": "ping"}  ->  {"status": "ok"}
               {"cmd": "quit"}  ->  process exits

2) Legacy CLI (one-shot, loads model per invocation):
     python3 card_cropper_sam.py <output_dir> <image1> [image2 ...]

Output: JSON to stdout, all diagnostics to stderr.

SAM model (facebook/sam-vit-base, ~375MB) is downloaded to ~/.cache/huggingface/
on first run and cached for subsequent runs.
"""

import sys
import os
import json
import warnings
import contextlib
import io
import signal
import faulthandler
from pathlib import Path

# Suppress noise before any imports
warnings.filterwarnings("ignore")
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'

# Force CPU-only execution. MPS/Metal interaction with IOGPUFamily has been
# correlated with `ptep_get_ptd: invalid PV head` kernel panics on Apple Silicon,
# so we disable MPS belt-and-suspenders even though SAM already runs on CPU.
os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '0'
os.environ['PYTORCH_MPS_DISABLE'] = '1'
os.environ['CUDA_VISIBLE_DEVICES'] = ''

faulthandler.enable()

# Capture real stdout/stderr before any heavy imports so the worker loop can
# write responses without getting drowned in warnings from transformers/torch.
_real_stdout = sys.stdout
_real_stderr = sys.stderr


def _emergency_exit(signum, frame):
    try:
        _real_stdout.flush()
    except Exception:
        pass
    os._exit(1)


signal.signal(signal.SIGTERM, _emergency_exit)
if hasattr(signal, 'SIGBUS'):
    signal.signal(signal.SIGBUS, _emergency_exit)


# ── Constants ────────────────────────────────────────────────────────────────

# SAM model to use.  sam-vit-base is ~375MB and fast; sam-vit-large is more accurate.
SAM_MODEL_ID = os.environ.get('SAM_MODEL_ID', 'facebook/sam-vit-base')

# Trading card aspect ratios (width/height)
CARD_ASPECT_PORTRAIT  = 2.5 / 3.5   # ~0.714 — the standard orientation
CARD_ASPECT_LANDSCAPE = 3.5 / 2.5   # ~1.400

ASPECT_TOLERANCE = 0.22     # allow ±22% deviation from card aspect ratio
MIN_AREA_FRACTION = 0.03    # card must be at least 3% of the image
MAX_AREA_FRACTION = 0.97    # card must not be nearly the whole image
MIN_SOLIDITY = 0.75         # mask area / convex hull area (cards are solid rectangles)

# Probe strategy: instead of a dense grid (slow), use a small set of strategic
# positions that cover where a card is likely to appear in a photo.
# Each probe is (x_fraction, y_fraction) — 0.0 = left/top, 1.0 = right/bottom.
# These 13 points cover the center, quadrant centers, and mid-edge positions.
PROBE_POINTS_FRACTIONS = [
    (0.50, 0.50),   # center — most important single probe
    (0.25, 0.25), (0.75, 0.25),   # upper quadrant centers
    (0.25, 0.75), (0.75, 0.75),   # lower quadrant centers
    (0.50, 0.25), (0.50, 0.75),   # top/bottom mid-edge
    (0.25, 0.50), (0.75, 0.50),   # left/right mid-edge
    (0.33, 0.33), (0.67, 0.33),   # inner grid for off-center cards
    (0.33, 0.67), (0.67, 0.67),
]

# Max image dimension for SAM processing (SAM internally resizes to 1024 anyway)
MAX_SAM_SIDE = 1500


# ── Singleton model cache ────────────────────────────────────────────────────

_model = None
_processor = None


def load_model():
    """Load SAM model and processor once; cache globally.

    Uses CPU to avoid MPS float64 compatibility issues with some torch versions.
    SAM-vit-base inference on Apple Silicon CPU is typically 3-8 seconds per image.

    All stdout/stderr is redirected to StringIO buffers during import and model
    construction so any library chatter (transformers warnings, HF cache messages)
    can't corrupt the JSON worker protocol.
    """
    global _model, _processor
    if _model is not None:
        return _model, _processor

    buf_out, buf_err = io.StringIO(), io.StringIO()
    sys.stdout, sys.stderr = buf_out, buf_err
    try:
        import torch
        # Hard-disable MPS so transformers/accelerate can't auto-route to Metal.
        torch.backends.mps.is_available = lambda: False
        torch.backends.mps.is_built = lambda: False
        # Reduce PyTorch memory footprint: disable gradients and limit thread count
        torch.set_grad_enabled(False)
        torch.set_num_threads(1)

        import transformers
        transformers.logging.set_verbosity_error()
        from transformers import SamModel, SamProcessor

        # Try local cache first (offline-friendly); fall back to download.
        try:
            _processor = SamProcessor.from_pretrained(SAM_MODEL_ID, local_files_only=True)
            _model = SamModel.from_pretrained(SAM_MODEL_ID, local_files_only=True)
        except Exception:
            _processor = SamProcessor.from_pretrained(SAM_MODEL_ID)
            _model = SamModel.from_pretrained(SAM_MODEL_ID)

        _model.eval()
    finally:
        sys.stdout = _real_stdout
        sys.stderr = _real_stderr
        buf_out.close()
        buf_err.close()

    # Keep on CPU — avoids MPS float64 incompatibility and is fast enough for inference
    return _model, _processor


# ── Image utilities ──────────────────────────────────────────────────────────

def open_and_resize_pil(image_path: str):
    """Open image, resize so the longest side is ≤ MAX_SAM_SIDE.

    Returns (PIL.Image, orig_w, orig_h, scale_ratio).
    """
    from PIL import Image
    img = Image.open(image_path).convert('RGB')
    orig_w, orig_h = img.size
    ratio = min(MAX_SAM_SIDE / orig_w, MAX_SAM_SIDE / orig_h, 1.0)
    if ratio < 1.0:
        new_w, new_h = int(orig_w * ratio), int(orig_h * ratio)
        img = img.resize((new_w, new_h), Image.LANCZOS)
    return img, orig_w, orig_h, ratio


# ── SAM mask generation ───────────────────────────────────────────────────────

def generate_masks(pil_image, model, processor):
    """Generate candidate masks by probing strategic points across the image.

    Key optimisation: compute the SAM image embedding ONCE (the expensive part,
    ~1-2s on CPU) then probe all strategic points using the cached embedding
    (each probe is ~0.04s). Total time: ~2-3s per image vs. ~20s with naive batching.

    Returns list of (mask_numpy_bool, iou_score_float).
    """
    import torch
    import numpy as np

    img_w, img_h = pil_image.size

    # ── Step 1: Encode image ONCE (the expensive vision-encoder pass) ──────────
    base_inputs = processor(images=pil_image, return_tensors='pt')
    original_sizes = base_inputs['original_sizes']          # [1, 2]
    reshaped_sizes = base_inputs['reshaped_input_sizes']    # [1, 2]

    with torch.no_grad():
        image_embeddings = model.get_image_embeddings(base_inputs['pixel_values'])
    # image_embeddings: [1, 256, 64, 64]

    # ── Step 2: Probe each strategic point using the cached embedding ──────────
    probe_pts = [[fx * img_w, fy * img_h] for fx, fy in PROBE_POINTS_FRACTIONS]
    results = []

    for pt in probe_pts:
        # Encode just the prompt (cheap)
        prompt_inputs = processor(
            images=pil_image,
            input_points=[[[pt]]],    # [1, 1, 1, 2]
            input_labels=[[[1]]],     # [1, 1, 1]
            return_tensors='pt',
        )

        with torch.no_grad():
            outputs = model(
                image_embeddings=image_embeddings,
                input_points=prompt_inputs.get('input_points'),
                input_labels=prompt_inputs.get('input_labels'),
            )

        # pred_masks: [1, 1, 3, 256, 256]
        masks_tensors = processor.post_process_masks(
            outputs.pred_masks.cpu(),
            original_sizes.cpu(),
            reshaped_sizes.cpu(),
        )
        iou_scores = outputs.iou_scores.cpu()   # [1, 1, 3]

        # masks_tensors[0]: [1, 3, H, W]
        for k in range(3):
            mask_np = masks_tensors[0][0, k].numpy().astype(bool)
            score = float(iou_scores[0, 0, k].item())
            results.append((mask_np, score))

    return results


# ── Card mask selection ───────────────────────────────────────────────────────

def pick_card_mask(mask_candidates, pil_size):
    """Select the mask most likely to represent the trading card.

    Filters by:
      - Area fraction (3% – 97% of image)
      - Solidity: mask_area / convex_hull_area  (cards are dense rectangles)
      - Aspect ratio via minAreaRect: should be close to 2.5:3.5 (or rotated)

    Among candidates, sorts by aspect-ratio closeness then IOU score.

    Returns (contour_pts_array, iou_score) or None if nothing qualifies.
    """
    import cv2
    import numpy as np

    img_w, img_h = pil_size
    img_area = img_w * img_h

    candidates = []

    for mask_np, score in mask_candidates:
        if score < 0.5:         # discard very low-confidence predictions
            continue

        mask_u8 = mask_np.astype(np.uint8) * 255
        mask_area = int(mask_np.sum())
        area_frac = mask_area / img_area

        if not (MIN_AREA_FRACTION < area_frac < MAX_AREA_FRACTION):
            continue

        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        c = max(contours, key=cv2.contourArea)
        contour_area = cv2.contourArea(c)
        if contour_area < 1:
            continue

        # Solidity check
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = contour_area / hull_area if hull_area > 0 else 0
        if solidity < MIN_SOLIDITY:
            continue

        # Aspect ratio via minAreaRect (handles tilted cards)
        rect = cv2.minAreaRect(c)
        rw, rh = rect[1]
        if rh == 0 or rw == 0:
            continue
        # Normalize so portrait_aspect = min/max < 1
        portrait_aspect = min(rw, rh) / max(rw, rh)

        port_err = abs(portrait_aspect - CARD_ASPECT_PORTRAIT)
        land_err = abs(portrait_aspect - CARD_ASPECT_LANDSCAPE)
        aspect_err = min(port_err, land_err)

        if aspect_err > ASPECT_TOLERANCE:
            continue

        candidates.append({
            'contour': c,
            'rect': rect,
            'score': score,
            'aspect_err': aspect_err,
            'area_frac': area_frac,
        })

    if not candidates:
        return None, None

    # Best = lowest aspect error, then highest IOU score
    candidates.sort(key=lambda x: (x['aspect_err'], -x['score']))
    best = candidates[0]

    box = cv2.boxPoints(best['rect']).astype(np.float32)
    return box, best['score']


# ── Rotation + crop (shared utilities) ───────────────────────────────────────

from card_cropper_utils import compute_rotation_angle, rotate_and_crop as _rotate_and_crop, contour_fallback  # noqa: E402


def rotate_and_crop(image, pts, scale_ratio: float):
    """Scale pts from SAM's resized image back to full-resolution, then rotate + crop."""
    import numpy as np
    orig_pts = (np.array(pts, dtype=np.float32) / scale_ratio)
    return _rotate_and_crop(image, orig_pts, padding=5)


# ── Per-image processing ──────────────────────────────────────────────────────

def process_image(img_path: str, output_dir: str, model, processor) -> dict:
    import cv2
    import numpy as np

    try:
        img = cv2.imread(img_path)
        if img is None:
            raise ValueError(f"Could not read image: {img_path}")

        img_stem = Path(img_path).stem

        # ── Step 1: Resize for SAM ────────────────────────────────────────────
        pil_img, orig_w, orig_h, scale_ratio = open_and_resize_pil(img_path)
        # ── Step 2: Generate SAM masks ────────────────────────────────────────
        mask_candidates = generate_masks(pil_img, model, processor)

        # ── Step 3: Pick the card mask ────────────────────────────────────────
        card_pts_sam, iou_score = pick_card_mask(mask_candidates, pil_img.size)

        # ── Step 4: Determine final corner points ─────────────────────────────
        if card_pts_sam is not None:
            # Scale from SAM (resized) space to original full-res space here
            # (rotate_and_crop will do the actual scaling)
            card_pts = card_pts_sam
            confidence = iou_score if iou_score is not None else 0.9
        else:
            # Contour fallback operates directly on the full-res image
            fb_pts = contour_fallback(img)
            if fb_pts is None:
                raise ValueError("SAM and contour fallback both failed; no card found.")
            # Pretend scale_ratio=1 since these are already in full-res coords
            card_pts = fb_pts
            scale_ratio = 1.0
            confidence = 0.5

        # ── Step 5: Rotate + crop ─────────────────────────────────────────────
        cropped, final_pts = rotate_and_crop(img, card_pts, scale_ratio)

        if cropped.size == 0:
            raise ValueError("Crop result is empty.")

        # ── Step 6: Save ──────────────────────────────────────────────────────
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        out_path = os.path.join(output_dir, f"{img_stem}_card.jpg")
        cv2.imwrite(out_path, cropped)

        return {
            "success": True,
            "image_path": img_path,
            "cards": [{
                "original_path": img_path,
                "cropped_path": out_path,
                "coordinates": final_pts.tolist(),
                "confidence": float(confidence),
            }],
        }

    except Exception as e:
        return {
            "success": False,
            "image_path": img_path,
            "error": str(e),
        }


# ── Persistent worker loop ───────────────────────────────────────────────────

def _run_crop_request(paths, output_dir, model, processor):
    """Process a batch of images, redirecting any library chatter away from stdout.

    Returns the list of per-image result dicts. Individual image failures are
    captured inside process_image() and returned as {success: False, error: ...},
    so one bad image never crashes the worker.
    """
    buf_out, buf_err = io.StringIO(), io.StringIO()
    sys.stdout, sys.stderr = buf_out, buf_err
    try:
        return [process_image(p, output_dir, model, processor) for p in paths]
    finally:
        sys.stdout = _real_stdout
        sys.stderr = _real_stderr
        buf_out.close()
        buf_err.close()


def run_worker():
    """Read JSON requests from stdin, write JSON responses to stdout (one per line).

    The SAM model is loaded once at startup and kept warm for the life of the
    process — no more 375MB reload per call.
    """
    # Eagerly load the model so the first crop request is fast
    model, processor = load_model()

    # Signal readiness to the parent process
    _real_stdout.write(json.dumps({"status": "ready"}) + "\n")
    _real_stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            _real_stdout.write(json.dumps({"error": "Invalid JSON"}) + "\n")
            _real_stdout.flush()
            continue

        cmd = request.get("cmd")
        if cmd == "ping":
            _real_stdout.write(json.dumps({"status": "ok"}) + "\n")
            _real_stdout.flush()
            continue
        if cmd == "quit":
            break

        # Default / "crop" command
        paths = request.get("paths", [])
        output_dir = request.get("output_dir", "input/tmp")

        if not paths:
            _real_stdout.write(json.dumps([]) + "\n")
            _real_stdout.flush()
            continue

        try:
            results = _run_crop_request(paths, output_dir, model, processor)
        except Exception as e:
            # Catastrophic failure (shouldn't happen since process_image catches
            # its own exceptions) — emit a per-image error so the parent can
            # still pair responses with requests.
            results = [
                {"success": False, "image_path": p, "error": f"worker error: {e}"}
                for p in paths
            ]

        _real_stdout.write(json.dumps(results) + "\n")
        _real_stdout.flush()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    # No CLI arguments → persistent worker mode
    if len(sys.argv) <= 1:
        run_worker()
        os._exit(0)  # skip Py_FinalizeEx — avoids PyTorch/C-extension segfault during cleanup

    # Legacy one-shot CLI mode (keeps standalone testing working)
    if len(sys.argv) < 3:
        print(
            "Usage: python3 card_cropper_sam.py <output_dir> <image1> [image2 ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    output_dir = sys.argv[1]
    image_paths = sys.argv[2:]

    model, processor = load_model()

    results = [process_image(p, output_dir, model, processor) for p in image_paths]

    # Only JSON goes to stdout
    print(json.dumps(results))
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()

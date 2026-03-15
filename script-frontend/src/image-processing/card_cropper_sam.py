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

Usage (identical to card_cropper_yolo.py):
    python3 card_cropper_sam.py <output_dir> <image1> [image2 ...]

Output: JSON array to stdout, all diagnostics to stderr.

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

faulthandler.enable()


def _emergency_exit(signum, frame):
    try:
        sys.stdout.flush()
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
    """
    global _model, _processor
    if _model is not None:
        return _model, _processor

    import torch

    print(f"[sam_cropper] Loading SAM model ({SAM_MODEL_ID})...", file=sys.stderr)

    from transformers import SamModel, SamProcessor

    # Try to load from local cache first (avoids network check; works offline / cloud servers).
    # Fall back to downloading if the cache is missing.
    try:
        _processor = SamProcessor.from_pretrained(SAM_MODEL_ID, local_files_only=True)
        _model = SamModel.from_pretrained(SAM_MODEL_ID, local_files_only=True)
        print(f"[sam_cropper] Loaded from local cache.", file=sys.stderr)
    except Exception:
        print(f"[sam_cropper] Not in cache, downloading...", file=sys.stderr)
        _processor = SamProcessor.from_pretrained(SAM_MODEL_ID)
        _model = SamModel.from_pretrained(SAM_MODEL_ID)

    _model.eval()
    # Keep on CPU — avoids MPS float64 incompatibility and is fast enough for inference
    print(f"[sam_cropper] Model loaded (device=cpu).", file=sys.stderr)
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

    print(f"[sam_cropper] Generated {len(results)} mask candidates from {len(probe_pts)} probe points.", file=sys.stderr)
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

    print(
        f"[sam_cropper] Best mask: area={best['area_frac']:.1%}, "
        f"aspect_err={best['aspect_err']:.3f}, iou={best['score']:.3f}",
        file=sys.stderr,
    )

    box = cv2.boxPoints(best['rect']).astype(np.float32)
    return box, best['score']


# ── Rotation + crop ──────────────────────────────────────────────────────────

def compute_rotation_angle(pts):
    """Compute the angle to rotate the image to align the card with the axes.

    OpenCV 4.x minAreaRect returns angle in (0, 90].  Convention:
      - If rect_w > rect_h → long side is "width" → for portrait card, rotate -(90-angle)
      - If rect_w <= rect_h → short side is "width" → rotate -angle
    """
    import cv2
    import numpy as np

    pts32 = np.array(pts, dtype=np.float32)
    rect = cv2.minAreaRect(pts32)
    rw, rh = rect[1]
    angle = rect[2]

    if rw == 0 or rh == 0:
        return 0.0, rect

    if rw > rh:
        rotation_angle = -(90.0 - angle)
    else:
        rotation_angle = -angle

    return rotation_angle, rect


def rotate_and_crop(image, pts, scale_ratio: float):
    """
    1. Scale pts from SAM's resized image back to the full-resolution image.
    2. Rotate the full-resolution image to align card edges with axes.
    3. Crop the axis-aligned bounding box of the card.

    Returns (cropped_image, final_pts_in_rotated_frame).
    """
    import cv2
    import numpy as np

    # Scale corner points back to original image coordinates
    orig_pts = pts / scale_ratio

    rotation_angle, _rect = compute_rotation_angle(orig_pts)

    img_h, img_w = image.shape[:2]
    cx, cy = img_w / 2.0, img_h / 2.0

    if abs(rotation_angle) > 0.5:
        M = cv2.getRotationMatrix2D((cx, cy), rotation_angle, 1.0)

        # Expand canvas to avoid clipping corners after rotation
        cos_a = abs(M[0, 0])
        sin_a = abs(M[0, 1])
        new_w = int(img_h * sin_a + img_w * cos_a)
        new_h = int(img_h * cos_a + img_w * sin_a)
        M[0, 2] += (new_w - img_w) / 2.0
        M[1, 2] += (new_h - img_h) / 2.0

        rotated = cv2.warpAffine(
            image, M, (new_w, new_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )

        pts_h = np.hstack([orig_pts, np.ones((len(orig_pts), 1), dtype=np.float32)])
        rotated_pts = (M @ pts_h.T).T
    else:
        rotated = image
        rotated_pts = orig_pts

    PADDING = 5  # pixels to include beyond the detected card edge
    xs, ys = rotated_pts[:, 0], rotated_pts[:, 1]
    x1 = int(max(0, xs.min() - PADDING))
    y1 = int(max(0, ys.min() - PADDING))
    x2 = int(min(rotated.shape[1], xs.max() + PADDING))
    y2 = int(min(rotated.shape[0], ys.max() + PADDING))

    return rotated[y1:y2, x1:x2], rotated_pts


# ── Contour fallback ─────────────────────────────────────────────────────────

def contour_fallback(image):
    """Fall back to classical edge detection to locate 4 card corners.

    Replicates the best strategy from card_cropper_yolo.py: CLAHE + Canny +
    morphological closing + minAreaRect on the largest qualifying contour.

    Returns numpy array (4, 2) in image coordinates, or None.
    """
    import cv2
    import numpy as np

    img_h, img_w = image.shape[:2]
    img_area = img_h * img_w
    min_area = 0.04 * img_area
    border_tol = 3

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blur = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edged = cv2.Canny(blur, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(edged, cv2.MORPH_CLOSE, kernel)

    for binary in [
        closed,
        cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2),
    ]:
        contours, _ = cv2.findContours(binary.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        large = [c for c in contours if cv2.contourArea(c) > min_area]

        def is_border(cnt):
            x, y, w, h = cv2.boundingRect(cnt)
            return (x < border_tol and y < border_tol
                    and abs(x + w - img_w) < border_tol
                    and abs(y + h - img_h) < border_tol)

        large = [c for c in large if not is_border(c)]
        if large:
            c = max(large, key=cv2.contourArea)
            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            return box.astype(np.float32)

    print("[sam_cropper] Contour fallback: no card found by edge detection.", file=sys.stderr)
    return None


# ── Per-image processing ──────────────────────────────────────────────────────

def process_image(img_path: str, output_dir: str, model, processor) -> dict:
    import cv2
    import numpy as np

    print(f"[sam_cropper] Processing: {img_path}", file=sys.stderr)

    try:
        img = cv2.imread(img_path)
        if img is None:
            raise ValueError(f"Could not read image: {img_path}")

        img_stem = Path(img_path).stem

        # ── Step 1: Resize for SAM ────────────────────────────────────────────
        pil_img, orig_w, orig_h, scale_ratio = open_and_resize_pil(img_path)
        pil_w, pil_h = pil_img.size
        print(
            f"[sam_cropper] Image {orig_w}×{orig_h} → SAM input {pil_w}×{pil_h} "
            f"(scale={scale_ratio:.3f})",
            file=sys.stderr,
        )

        # ── Step 2: Generate SAM masks ────────────────────────────────────────
        mask_candidates = generate_masks(pil_img, model, processor)

        # ── Step 3: Pick the card mask ────────────────────────────────────────
        card_pts_sam, iou_score = pick_card_mask(mask_candidates, pil_img.size)

        if card_pts_sam is not None:
            print(f"[sam_cropper] SAM found card mask (IOU={iou_score:.3f}).", file=sys.stderr)
        else:
            print("[sam_cropper] SAM mask selection failed; using contour fallback.", file=sys.stderr)

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
        print(f"[sam_cropper] Saved: {out_path}", file=sys.stderr)

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
        print(f"[sam_cropper] ERROR for {img_path}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {
            "success": False,
            "image_path": img_path,
            "error": str(e),
        }


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(
            "Usage: python3 card_cropper_sam.py <output_dir> <image1> [image2 ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    output_dir = sys.argv[1]
    image_paths = sys.argv[2:]

    model, processor = load_model()

    results = []
    for img_path in image_paths:
        results.append(process_image(img_path, output_dir, model, processor))

    # Only JSON goes to stdout
    print(json.dumps(results))


if __name__ == "__main__":
    main()

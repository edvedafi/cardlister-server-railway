#!/usr/bin/env python3
"""
card_cropper_ollama.py

Detect and crop a trading card from a photo using Ollama's vision model for
coarse bounding-box detection, then refine the rotation angle via OpenCV edge
detection within the detected region.

Handles cards with black edges on a black backdrop (which defeats pure edge
detection) by using Ollama's semantic understanding for the initial locate step.

After locating the card, the image is rotated so the card's edges are perfectly
horizontal/vertical before cropping (not just a perspective transform — a true
rotation so printed text appears upright).

Usage (identical to card_cropper_yolo.py):
    python3 card_cropper_ollama.py <output_dir> <image1> [image2 ...]

Output: JSON array to stdout, all diagnostics to stderr.

Environment variables:
    OLLAMA_HOST   — Ollama API endpoint (default: http://localhost:11434)
    OLLAMA_MODEL  — Ollama vision model  (default: llama3.2-vision:11b)
"""

import sys
import os
import json
import re
import base64
import warnings
import contextlib
import io
import signal
import faulthandler
from pathlib import Path
from io import BytesIO

warnings.filterwarnings("ignore")
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

MAX_IMAGE_SIDE = 1500     # Resize to this max before sending to Ollama
OLLAMA_TIMEOUT = 180      # seconds

# Trading card aspect ratio: 2.5" wide × 3.5" tall (portrait)
CARD_ASPECT_PORTRAIT  = 2.5 / 3.5   # ~0.714
CARD_ASPECT_LANDSCAPE = 3.5 / 2.5   # ~1.400

# Prompts
BBOX_SYSTEM_PROMPT = (
    "You are a precise image analysis assistant. "
    "When asked to locate an object, return only a JSON object with exact pixel coordinates. "
    "No markdown, no explanation, no extra text."
)

BBOX_USER_PROMPT = (
    "This image shows a trading card (like a sports card with a player photo) placed on a backdrop. "
    "The backdrop may be black, white, or any colour. The card may be slightly tilted.\n\n"
    "Your task: find the tight bounding box of JUST the trading card — not the whole image.\n\n"
    "Return coordinates as normalized fractions of image width/height (values between 0.0 and 1.0):\n"
    '{"x1": <left fraction>, "y1": <top fraction>, "x2": <right fraction>, "y2": <bottom fraction>}\n\n'
    "Example: if the card's left edge is 10% from the left of the image, x1=0.10\n"
    "x1,y1 = top-left corner.  x2,y2 = bottom-right corner.\n"
    "Return ONLY the JSON object. No other text."
)

BBOX_RETRY_PROMPT = (
    "Find the trading card (rectangular object with player/sports imagery) in this photo and "
    "return its bounding box as normalized fractions (0.0-1.0) of image dimensions.\n"
    "Return only JSON:\n"
    '{"x1": <left 0-1>, "y1": <top 0-1>, "x2": <right 0-1>, "y2": <bottom 0-1>}'
)


# ── Image utilities ──────────────────────────────────────────────────────────

def load_and_resize_image(image_path: str):
    """Load image, resize to max MAX_IMAGE_SIDE on the longest side.

    Returns (jpeg_bytes, original_width, original_height, scale_ratio).
    """
    from PIL import Image
    img = Image.open(image_path).convert('RGB')
    orig_w, orig_h = img.size
    ratio = min(MAX_IMAGE_SIDE / orig_w, MAX_IMAGE_SIDE / orig_h, 1.0)
    new_w, new_h = int(orig_w * ratio), int(orig_h * ratio)
    if ratio < 1.0:
        img = img.resize((new_w, new_h), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format='JPEG', quality=85)
    return buf.getvalue(), orig_w, orig_h, ratio


def encode_image(image_path: str):
    """Return (base64_string, orig_w, orig_h, scale_ratio)."""
    data, orig_w, orig_h, ratio = load_and_resize_image(image_path)
    b64 = base64.standard_b64encode(data).decode('utf-8')
    return b64, orig_w, orig_h, ratio


# ── Ollama HTTP call ─────────────────────────────────────────────────────────

def _ollama_request(image_b64: str, prompt: str, ollama_host: str, ollama_model: str) -> dict:
    """POST a single image to Ollama and return the parsed JSON response dict."""
    import urllib.request
    import urllib.error

    payload = {
        "model": ollama_model,
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [image_b64],
        }],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        f"{ollama_host}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to connect to Ollama at {ollama_host}: {e}")

    content = result.get("message", {}).get("content", "")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Try to extract a JSON object substring
        m = re.search(r'\{[^}]+\}', content, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
        raise RuntimeError(f"Ollama returned non-JSON bbox content: {content!r}")


# ── Bbox parsing / validation ────────────────────────────────────────────────

def parse_bbox(parsed: dict, resized_w: int, resized_h: int, orig_ratio: float):
    """
    Parse Ollama's bbox response and convert to 4 corner points in original
    image coordinates.

    Handles both pixel coordinates and normalized (0.0-1.0) coordinates,
    since llama3.2-vision may return either format.

    Returns numpy array of shape (4, 2): [TL, TR, BR, BL].
    Raises ValueError if coordinates are implausible.
    """
    import numpy as np

    # Accept various key naming conventions the model might use
    def get_val(d, *keys):
        for k in keys:
            v = d.get(k)
            if v is not None:
                return v
        return None

    x1 = get_val(parsed, "x1", "left", "xmin", "x_min")
    y1 = get_val(parsed, "y1", "top", "ymin", "y_min")
    x2 = get_val(parsed, "x2", "right", "xmax", "x_max")
    y2 = get_val(parsed, "y2", "bottom", "ymax", "y_max")

    if any(v is None for v in [x1, y1, x2, y2]):
        raise ValueError(f"Missing bbox keys in Ollama response: {parsed}")

    x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)

    # Detect normalized (0-1) coordinates: if all values are <= 1.5 treat as normalized
    if max(x1, y1, x2, y2) <= 1.5:
        print(f"[parse_bbox] Detected normalized coordinates; scaling to {resized_w}x{resized_h}", file=sys.stderr)
        x1 = x1 * resized_w
        y1 = y1 * resized_h
        x2 = x2 * resized_w
        y2 = y2 * resized_h

    # Clamp to resized image bounds
    x1 = max(0.0, min(x1, resized_w - 1))
    y1 = max(0.0, min(y1, resized_h - 1))
    x2 = max(0.0, min(x2, resized_w - 1))
    y2 = max(0.0, min(y2, resized_h - 1))

    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"Invalid bbox order: x1={x1:.1f}, y1={y1:.1f}, x2={x2:.1f}, y2={y2:.1f}")

    area_frac = ((x2 - x1) * (y2 - y1)) / (resized_w * resized_h)
    if area_frac < 0.03:
        raise ValueError(f"Bbox is too small ({area_frac:.1%} of image)")
    # Note: we allow up to 99% — a card can legitimately fill almost the whole frame
    if area_frac > 0.99:
        raise ValueError(f"Bbox is the entire image ({area_frac:.1%}); Ollama likely returned whole-frame coords")

    # Scale back to original image coordinates
    s = 1.0 / orig_ratio
    x1o, y1o, x2o, y2o = x1 * s, y1 * s, x2 * s, y2 * s

    pts = np.array([
        [x1o, y1o],
        [x2o, y1o],
        [x2o, y2o],
        [x1o, y2o],
    ], dtype=np.float32)

    return pts


# ── Rotation helpers ─────────────────────────────────────────────────────────

def compute_rotation_angle(pts):
    """
    Given 4 corner points of a card (possibly tilted), compute the rotation
    angle (degrees) needed to make the card's edges perfectly
    horizontal / vertical.

    OpenCV 4.x minAreaRect returns angle in the range (0, 90].
    Convention: if rect_w > rect_h the long side is "width"; for a portrait
    card the long side should be vertical, so we need -(90-angle).
    """
    import cv2
    import numpy as np

    pts32 = np.array(pts, dtype=np.float32)
    rect = cv2.minAreaRect(pts32)
    rw, rh = rect[1]
    angle = rect[2]          # (0, 90]

    if rw == 0 or rh == 0:
        return 0.0, rect

    if rw > rh:
        # Long side returned as "width"  →  for portrait: rotate -(90-angle)
        rotation_angle = -(90.0 - angle)
    else:
        # Short side returned as "width"  →  rotate -angle
        rotation_angle = -angle

    return rotation_angle, rect


def rotate_and_crop(image, pts):
    """
    Rotate the image to align the card's edges with the image axes,
    then crop the axis-aligned bounding box of the card.

    This produces a result where printed text reads normally (no distortion),
    unlike warpPerspective which can skew the image.
    """
    import cv2
    import numpy as np

    rotation_angle, _rect = compute_rotation_angle(pts)

    img_h, img_w = image.shape[:2]
    cx, cy = img_w / 2.0, img_h / 2.0

    if abs(rotation_angle) > 0.5:
        M = cv2.getRotationMatrix2D((cx, cy), rotation_angle, 1.0)

        # Expand canvas so no content is clipped after rotation
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

        # Map the corner points into the rotated frame
        pts_h = np.hstack([pts, np.ones((len(pts), 1), dtype=np.float32)])
        rotated_pts = (M @ pts_h.T).T
    else:
        rotated = image
        rotated_pts = pts

    # Axis-aligned bounding box crop
    xs, ys = rotated_pts[:, 0], rotated_pts[:, 1]
    x1 = int(max(0, xs.min()))
    y1 = int(max(0, ys.min()))
    x2 = int(min(rotated.shape[1], xs.max()))
    y2 = int(min(rotated.shape[0], ys.max()))

    return rotated[y1:y2, x1:x2], rotated_pts


# ── Rotation refinement via ROI edge detection ───────────────────────────────

def refine_corners_from_roi(image, coarse_pts):
    """
    Use edge detection within the coarse card ROI to find the precise
    tilted corner points.  Helps when Ollama gives an axis-aligned bbox for
    a tilted card.

    Returns refined 4-corner numpy array, or the original coarse_pts on failure.
    """
    import cv2
    import numpy as np

    xs, ys = coarse_pts[:, 0], coarse_pts[:, 1]
    x1 = int(max(0, xs.min()))
    y1 = int(max(0, ys.min()))
    x2 = int(min(image.shape[1], xs.max()))
    y2 = int(min(image.shape[0], ys.max()))

    roi_w, roi_h = x2 - x1, y2 - y1
    if roi_w < 10 or roi_h < 10:
        return coarse_pts

    # Expand ROI by 8% on each side to capture card edges that may sit outside
    margin_x = int(roi_w * 0.08)
    margin_y = int(roi_h * 0.08)
    rx1 = max(0, x1 - margin_x)
    ry1 = max(0, y1 - margin_y)
    rx2 = min(image.shape[1], x2 + margin_x)
    ry2 = min(image.shape[0], y2 + margin_y)

    roi = image[ry1:ry2, rx1:rx2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # CLAHE: improves contrast for black-on-black edges
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    blur = cv2.GaussianBlur(enhanced, (5, 5), 0)
    edges = cv2.Canny(blur, 30, 150)

    # Morphological closing to bridge small gaps
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        print(f"[refine_corners] No contours in ROI; keeping coarse bbox.", file=sys.stderr)
        return coarse_pts

    largest = max(contours, key=cv2.contourArea)
    min_roi_area = 0.05 * roi_w * roi_h
    if cv2.contourArea(largest) < min_roi_area:
        print(f"[refine_corners] Largest ROI contour too small; keeping coarse bbox.", file=sys.stderr)
        return coarse_pts

    rect = cv2.minAreaRect(largest)
    box = cv2.boxPoints(rect)
    box = box.astype(np.float32)

    # Offset back to full image coordinates
    box[:, 0] += rx1
    box[:, 1] += ry1

    print(f"[refine_corners] Refined card corners from ROI edge detection.", file=sys.stderr)
    return box


# ── Contour fallback ─────────────────────────────────────────────────────────

def contour_fallback(image):
    """
    Fall back to classical edge detection to find the card's 4 corners.
    Returns numpy array (4, 2) or None.
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

    for binary in [closed, cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)]:
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

    print("[contour_fallback] Could not find card via edge detection.", file=sys.stderr)
    return None


# ── Per-image processing ──────────────────────────────────────────────────────

def process_image(img_path: str, output_dir: str, ollama_host: str, ollama_model: str) -> dict:
    import cv2
    from pathlib import Path

    print(f"[ollama_cropper] Processing: {img_path}", file=sys.stderr)

    try:
        import cv2 as _cv2
        img = _cv2.imread(img_path)
        if img is None:
            raise ValueError(f"Could not read image: {img_path}")

        img_h, img_w = img.shape[:2]
        img_stem = Path(img_path).stem

        # ── Step 1: Encode resized image for Ollama ──────────────────────────
        b64, orig_w, orig_h, ratio = encode_image(img_path)
        resized_w = int(orig_w * ratio)
        resized_h = int(orig_h * ratio)

        # ── Step 2: Get coarse bbox from Ollama (with one retry) ─────────────
        parsed = None
        for attempt, prompt in enumerate([BBOX_USER_PROMPT, BBOX_RETRY_PROMPT]):
            try:
                parsed = _ollama_request(b64, prompt, ollama_host, ollama_model)
                print(f"[ollama_cropper] Ollama response (attempt {attempt+1}): {parsed}", file=sys.stderr)
                break
            except RuntimeError as e:
                print(f"[ollama_cropper] Attempt {attempt+1} failed: {e}", file=sys.stderr)
                if attempt == 1:
                    raise

        if parsed is None:
            raise RuntimeError("Ollama did not return a valid bbox after retries")

        # ── Step 3: Parse + validate bbox ────────────────────────────────────
        try:
            coarse_pts = parse_bbox(parsed, resized_w, resized_h, ratio)
        except ValueError as e:
            print(f"[ollama_cropper] Invalid bbox from Ollama ({e}); using contour fallback.", file=sys.stderr)
            coarse_pts = None

        # ── Step 4: Refine corners via ROI edge detection ─────────────────────
        if coarse_pts is not None:
            card_pts = refine_corners_from_roi(img, coarse_pts)
        else:
            card_pts = None

        # ── Step 5: Contour fallback if needed ───────────────────────────────
        if card_pts is None:
            print(f"[ollama_cropper] Falling back to contour detection.", file=sys.stderr)
            card_pts = contour_fallback(img)
            if card_pts is None:
                raise ValueError("All detection methods failed; no card found.")

        # ── Step 6: Rotate + crop ─────────────────────────────────────────────
        cropped, _ = rotate_and_crop(img, card_pts)

        if cropped.size == 0:
            raise ValueError("Crop result is empty (zero size)")

        # ── Step 7: Save output ───────────────────────────────────────────────
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        out_path = os.path.join(output_dir, f"{img_stem}_card.jpg")
        cv2.imwrite(out_path, cropped)
        print(f"[ollama_cropper] Saved crop: {out_path}", file=sys.stderr)

        return {
            "success": True,
            "image_path": img_path,
            "cards": [{
                "original_path": img_path,
                "cropped_path": out_path,
                "coordinates": card_pts.tolist(),
                "confidence": 0.85,
            }],
        }

    except Exception as e:
        print(f"[ollama_cropper] ERROR for {img_path}: {e}", file=sys.stderr)
        return {
            "success": False,
            "image_path": img_path,
            "error": str(e),
        }


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(
            "Usage: python3 card_cropper_ollama.py <output_dir> <image1> [image2 ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    output_dir = sys.argv[1]
    image_paths = sys.argv[2:]

    ollama_host = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
    ollama_model = os.environ.get('OLLAMA_MODEL', 'llama3.2-vision:11b')

    print(f"[ollama_cropper] Using Ollama at {ollama_host}, model={ollama_model}", file=sys.stderr)

    results = []
    for img_path in image_paths:
        results.append(process_image(img_path, output_dir, ollama_host, ollama_model))

    # Only JSON goes to stdout
    import contextlib, io
    with contextlib.redirect_stdout(sys.stderr):
        pass
    print(json.dumps(results))
    sys.stdout.flush()
    os._exit(0)  # skip Py_FinalizeEx — avoids PyTorch/C-extension segfault during module cleanup


if __name__ == "__main__":
    main()

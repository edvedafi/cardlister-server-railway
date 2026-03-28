#!/usr/bin/env python3
"""
orient_cards.py

Detect and correct the orientation of cropped trading card images so that
text reads right-side-up.  Tests 0°, 90°, 180°, 270° rotations using EasyOCR
confidence scoring and picks the orientation with the most readable text.

Usage:
    python3 orient_cards.py <image1> [image2 ...]

Output: JSON array to stdout, all diagnostics to stderr.

Each image is overwritten in-place if rotation is needed.
"""
import sys
import json
import os
import signal
import faulthandler
import ssl
import warnings
from pathlib import Path
from io import StringIO

# ── Suppress warnings and noisy output ─────────────────────────────────────
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
warnings.filterwarnings('ignore')

import torch
torch.set_grad_enabled(False)
torch.set_num_threads(1)

# Handle SSL certificate issues on macOS
try:
    _create_unverified_https_context = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _create_unverified_https_context

_real_stdout = sys.stdout
_real_stderr = sys.stderr

faulthandler.enable()


def _emergency_exit(signum, frame):
    try:
        _real_stdout.flush()
    except Exception:
        pass
    os._exit(1)


signal.signal(signal.SIGTERM, _emergency_exit)
if hasattr(signal, 'SIGBUS'):
    signal.signal(signal.SIGBUS, _emergency_exit)

# ── Import EasyOCR (suppressing chatty output) ────────────────────────────
try:
    sys.stdout = StringIO()
    sys.stderr = StringIO()
    import easyocr
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
except ImportError:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
    print("Error: easyocr not found. Install with: pip install easyocr", file=sys.stderr)
    sys.exit(1)
except Exception:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
    sys.exit(1)

import cv2
import numpy as np

# ── Constants ──────────────────────────────────────────────────────────────
MAX_SIDE_FOR_OCR = 640          # downscale for faster OCR (orientation only)
EARLY_EXIT_AVG_CONF = 0.90     # avg confidence threshold to skip other rotations
EARLY_EXIT_MIN_DETECTIONS = 3  # minimum text detections to trust early exit
MIN_MEANINGFUL_DETECTIONS = 1  # at least this many to consider any rotation valid
MIN_MEANINGFUL_CONF = 0.3      # minimum confidence per detection to count

# cv2.rotate rotation codes for 90°, 180°, 270° clockwise
ROTATIONS = {
    0:   None,
    90:  cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

# ── Model management ──────────────────────────────────────────────────────
_reader = None


def get_reader():
    global _reader
    if _reader is None:
        buf_out, buf_err = StringIO(), StringIO()
        sys.stdout, sys.stderr = buf_out, buf_err
        try:
            _reader = easyocr.Reader(['en'], gpu=False, verbose=False)
        finally:
            sys.stdout = _real_stdout
            sys.stderr = _real_stderr
    return _reader


# ── Core logic ─────────────────────────────────────────────────────────────

def downscale(img, max_side=MAX_SIDE_FOR_OCR):
    """Downscale image so longest side is at most max_side."""
    h, w = img.shape[:2]
    if max(h, w) <= max_side:
        return img
    scale = max_side / max(h, w)
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def ocr_score(img, reader):
    """Run EasyOCR on img and return (sum_confidence, avg_confidence, num_detections)."""
    buf_out, buf_err = StringIO(), StringIO()
    sys.stdout, sys.stderr = buf_out, buf_err
    try:
        with torch.inference_mode():
            results = reader.readtext(img)
    finally:
        sys.stdout = _real_stdout
        sys.stderr = _real_stderr

    # Filter out very low confidence noise
    meaningful = [d for d in results if d[2] >= MIN_MEANINGFUL_CONF]
    if not meaningful:
        return 0.0, 0.0, 0
    total_conf = sum(d[2] for d in meaningful)
    avg_conf = total_conf / len(meaningful)
    return total_conf, avg_conf, len(meaningful)


def detect_orientation(image_path, reader):
    """Detect the correct orientation for a card image.

    Returns dict with image_path, rotation_applied, confidence, scores.
    """
    img = cv2.imread(str(image_path))
    if img is None:
        return {
            'image_path': str(image_path),
            'rotation_applied': 0,
            'confidence': 0.0,
            'text_detection_count': 0,
            'scores': {},
            'error': 'Could not read image',
        }

    small = downscale(img)
    scores = {}

    # Try 0° first — early exit if high confidence
    total_0, avg_0, n_0 = ocr_score(small, reader)
    scores['0'] = round(total_0, 3)

    if avg_0 >= EARLY_EXIT_AVG_CONF and n_0 >= EARLY_EXIT_MIN_DETECTIONS:
        return {
            'image_path': str(image_path),
            'rotation_applied': 0,
            'confidence': round(avg_0, 3),
            'text_detection_count': n_0,
            'scores': scores,
        }

    # Try remaining rotations
    best_angle = 0
    best_total = total_0
    best_detections = n_0

    for angle in [90, 180, 270]:
        rotated = cv2.rotate(small, ROTATIONS[angle])
        total, avg, n = ocr_score(rotated, reader)
        scores[str(angle)] = round(total, 3)
        if total > best_total:
            best_total = total
            best_angle = angle
            best_detections = n

    # Check if we have meaningful text at the best rotation
    if best_total < MIN_MEANINGFUL_CONF:
        return {
            'image_path': str(image_path),
            'rotation_applied': 0,
            'confidence': 0.0,
            'text_detection_count': 0,
            'scores': scores,
        }

    # Apply rotation to full-resolution image if needed
    if best_angle != 0:
        rotated_full = cv2.rotate(img, ROTATIONS[best_angle])
        cv2.imwrite(str(image_path), rotated_full, [cv2.IMWRITE_JPEG_QUALITY, 95])

    return {
        'image_path': str(image_path),
        'rotation_applied': best_angle,
        'confidence': round(best_total, 3),
        'text_detection_count': best_detections,
        'scores': scores,
    }


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <image1> [image2 ...]", file=sys.stderr)
        sys.exit(1)

    image_paths = sys.argv[1:]

    reader = get_reader()
    results = []

    for img_path in image_paths:
        p = Path(img_path)
        if not p.exists():
            results.append({
                'image_path': str(img_path),
                'rotation_applied': 0,
                'confidence': 0.0,
                'text_detection_count': 0,
                'scores': {},
                'error': 'File not found',
            })
            continue

        result = detect_orientation(img_path, reader)
        results.append(result)

    print(json.dumps(results), file=sys.stdout)


if __name__ == '__main__':
    main()

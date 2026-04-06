#!/usr/bin/env python3
"""
ocr_extractor.py

Persistent OCR worker process using EasyOCR (cost-effective alternative to Google Cloud Vision).

Protocol (newline-delimited JSON over stdin/stdout):
  Request:  {"images": ["/path/to/img1.jpg", "/path/to/img2.jpg"]}
  Response: [{"image_path": "...", "text": "...", "words": [...], "confidence": 0.95}, ...]

  Special:  {"cmd": "ping"}   ->  {"status": "ok"}
            {"cmd": "quit"}   ->  process exits

The model is loaded once at startup and kept in memory for all subsequent requests.

Legacy mode (CLI arguments) is still supported for backward compatibility:
  python ocr_extractor.py <image_path> [image_path2 ...]
"""
import sys
import json
import ssl
import os
import signal
import faulthandler
from pathlib import Path
from io import StringIO

import cv2
import numpy as np

# ── Suppress all warnings and noisy library output ──────────────────────────
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import warnings
warnings.filterwarnings('ignore')

# Reduce PyTorch memory footprint: disable gradients and limit internal threads
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

# ── Import EasyOCR (suppressing its chatty output) ──────────────────────────
_real_stdout = sys.stdout
_real_stderr = sys.stderr

# Dump a Python-level stack trace to stderr on fatal signals (SIGSEGV/SIGBUS/SIGABRT)
faulthandler.enable()

def _emergency_exit(signum, frame):
    """Flush stdout so the Node.js readline closes cleanly, then exit immediately."""
    try:
        _real_stdout.flush()
    except Exception:
        pass
    os._exit(1)  # skip normal Python cleanup which can deadlock in multi-threaded PyTorch

signal.signal(signal.SIGBUS, _emergency_exit)
signal.signal(signal.SIGTERM, _emergency_exit)

try:
    sys.stdout = StringIO()
    sys.stderr = StringIO()
    import easyocr
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
except ImportError:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
    print("Error: easyocr module not found. Install it with: pip install easyocr", file=sys.stderr)
    os._exit(1)
except Exception:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
    os._exit(1)

# ── Model management ────────────────────────────────────────────────────────
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
            buf_out.close()
            buf_err.close()
    return _reader

# ── Core OCR function ───────────────────────────────────────────────────────
def extract_text(image_path):
    """Extract all text from an image using EasyOCR."""
    buf_out, buf_err = StringIO(), StringIO()
    sys.stdout, sys.stderr = buf_out, buf_err
    try:
        ocr_reader = get_reader()
        with torch.inference_mode():
            results = ocr_reader.readtext(str(image_path))
        full_text = ' '.join([d[1] for d in results])
        return {
            'image_path': str(image_path),
            'text': full_text,
            'words': [d[1] for d in results],
            'confidence': sum(d[2] for d in results) / len(results) if results else 0,
        }
    except Exception as e:
        return {'image_path': str(image_path), 'text': '', 'error': str(e)}
    finally:
        sys.stdout = _real_stdout
        sys.stderr = _real_stderr
        buf_out.close()
        buf_err.close()


def process_images(image_paths):
    """Process a list of image paths and return results."""
    results = []
    for img_path in image_paths:
        if not Path(img_path).exists():
            results.append({'image_path': img_path, 'text': '', 'error': 'File not found'})
            continue
        results.append(extract_text(img_path))
    return results

# ── Orientation detection ──────────────────────────────────────────────────
# Ported from orient_cards.py — reuses the already-loaded EasyOCR model
# instead of spawning a separate process that loads a duplicate (~300MB).

MAX_SIDE_FOR_OCR = 1024
EARLY_EXIT_AVG_CONF = 0.90
EARLY_EXIT_MIN_DETECTIONS = 3
MIN_MEANINGFUL_CONF = 0.3

ROTATIONS = {
    0:   None,
    90:  cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


def downscale(img, max_side=MAX_SIDE_FOR_OCR):
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
        buf_out.close()
        buf_err.close()
    meaningful = [d for d in results if d[2] >= MIN_MEANINGFUL_CONF]
    if not meaningful:
        return 0.0, 0.0, 0
    total_conf = sum(d[2] for d in meaningful)
    avg_conf = total_conf / len(meaningful)
    return total_conf, avg_conf, len(meaningful)


def detect_orientation(image_path, reader):
    """Detect correct orientation, apply rotation in-place if needed."""
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

    if best_total < MIN_MEANINGFUL_CONF:
        return {
            'image_path': str(image_path),
            'rotation_applied': 0,
            'confidence': 0.0,
            'text_detection_count': 0,
            'scores': scores,
        }

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


def process_orient(image_paths):
    """Orient a batch of images and return results."""
    reader = get_reader()
    results = []
    for img_path in image_paths:
        if not Path(img_path).exists():
            results.append({
                'image_path': str(img_path),
                'rotation_applied': 0,
                'confidence': 0.0,
                'text_detection_count': 0,
                'scores': {},
                'error': 'File not found',
            })
            continue
        results.append(detect_orientation(img_path, reader))
    return results


# ── Persistent worker loop ──────────────────────────────────────────────────
def run_worker():
    """Read JSON requests from stdin, write JSON responses to stdout (one per line).

    This keeps the process (and the loaded model) alive between calls,
    avoiding the ~200-400 MB allocation spike on every invocation.
    """
    # Eagerly load the model so the first request is fast
    get_reader()

    # Signal readiness
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

        # Handle special commands
        cmd = request.get("cmd")
        if cmd == "ping":
            _real_stdout.write(json.dumps({"status": "ok"}) + "\n")
            _real_stdout.flush()
            continue
        if cmd == "quit":
            break
        if cmd == "orient":
            image_paths = request.get("images", [])
            if not image_paths:
                _real_stdout.write(json.dumps([]) + "\n")
                _real_stdout.flush()
                continue
            results = process_orient(image_paths)
            _real_stdout.write(json.dumps(results) + "\n")
            _real_stdout.flush()
            continue

        # Process images (default: OCR text extraction)
        image_paths = request.get("images", [])
        if not image_paths:
            _real_stdout.write(json.dumps([]) + "\n")
            _real_stdout.flush()
            continue

        results = process_images(image_paths)
        _real_stdout.write(json.dumps(results) + "\n")
        _real_stdout.flush()

# ── Entry point ─────────────────────────────────────────────────────────────
def main():
    # If CLI arguments are provided, run in legacy one-shot mode
    if len(sys.argv) > 1:
        try:
            results = process_images(sys.argv[1:])
            print(json.dumps(results))
            sys.stdout.flush()
            os._exit(0)
        except Exception:
            print(json.dumps([{'error': 'Failed to process images'}]))
            os._exit(1)

    # No arguments → persistent worker mode
    run_worker()
    os._exit(0)  # skip Py_FinalizeEx — avoids PyTorch/C-extension segfault during module cleanup

if __name__ == "__main__":
    main()

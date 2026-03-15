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
    sys.exit(1)
except Exception:
    sys.stdout = _real_stdout
    sys.stderr = _real_stderr
    sys.exit(1)

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


def process_images(image_paths):
    """Process a list of image paths and return results."""
    results = []
    for img_path in image_paths:
        if not Path(img_path).exists():
            results.append({'image_path': img_path, 'text': '', 'error': 'File not found'})
            continue
        results.append(extract_text(img_path))
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

        # Process images
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
        except Exception:
            print(json.dumps([{'error': 'Failed to process images'}]))
        return

    # No arguments → persistent worker mode
    run_worker()

if __name__ == "__main__":
    main()

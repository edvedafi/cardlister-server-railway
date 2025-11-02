#!/usr/bin/env python3
"""
download_models.py

Downloads EasyOCR models to avoid downloading during OCR processing.

Usage:
    python download_models.py
"""
import sys
import ssl
import urllib.request

# Handle SSL certificate issues on macOS
try:
    _create_unverified_https_context = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _create_unverified_https_context

try:
    import easyocr
    print("Initializing EasyOCR and downloading models...")
    print("This will download ~350MB of models (one-time only)")
    print("Please wait...\n")
    
    # Initialize reader - this will download models if needed
    reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    
    print("\n✓ EasyOCR models downloaded successfully!")
    print("You can now use OCR without download delays.\n")
    
except ImportError:
    print("Error: easyocr module not found.", file=sys.stderr)
    print("Install it with: pip install easyocr", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    import traceback
    print(f"Error downloading models: {e}", file=sys.stderr)
    traceback.print_exc(file=sys.stderr)
    print("\nTo fix SSL certificate issues on macOS, run:", file=sys.stderr)
    print("  bash '/Applications/Python 3.12/Install Certificates.command'", file=sys.stderr)
    sys.exit(1)


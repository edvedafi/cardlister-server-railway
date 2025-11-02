#!/usr/bin/env python3
"""
ocr_extractor.py

Extracts text from card images using EasyOCR (cost-effective alternative to Google Cloud Vision).

Usage:
    python ocr_extractor.py <image_path> [image_path2 ...]

Returns JSON with extracted text from each image.
"""
import sys
import json
import ssl
import urllib.request
import os
from pathlib import Path
from io import StringIO

# Suppress all warnings and EasyOCR output
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import warnings
warnings.filterwarnings('ignore')

# Handle SSL certificate issues on macOS
try:
    _create_unverified_https_context = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _create_unverified_https_context

try:
    # Suppress stdout/stderr during initialization
    _old_stdout = sys.stdout
    _old_stderr = sys.stderr
    
    # Suppress during import
    sys.stdout = StringIO()
    sys.stderr = StringIO()
    import easyocr
    sys.stdout = _old_stdout
    sys.stderr = _old_stderr
    
    reader = None
    
    def get_reader():
        global reader
        if reader is None:
            # Suppress all output
            null_stdout = StringIO()
            null_stderr = StringIO()
            sys.stdout = null_stdout
            sys.stderr = null_stderr
            
            try:
                reader = easyocr.Reader(['en'], gpu=False, verbose=False)
            finally:
                # Always restore output
                sys.stdout = _old_stdout
                sys.stderr = _old_stderr
                # Clear the buffers
                null_stdout.truncate(0)
                null_stderr.truncate(0)
        
        return reader
    
except ImportError:
    sys.stdout = _old_stdout
    sys.stderr = _old_stderr
    print("Error: easyocr module not found. Install it with: pip install easyocr", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    # Restore output if error
    sys.stdout = _old_stdout
    sys.stderr = _old_stderr
    sys.exit(1)

def extract_text(image_path):
    """Extract all text from an image using EasyOCR"""
    # Suppress output during OCR
    null_stdout = StringIO()
    null_stderr = StringIO()
    sys.stdout = null_stdout
    sys.stderr = null_stderr
    
    try:
        # Get or initialize reader
        ocr_reader = get_reader()
        
        # Read text from image
        results = ocr_reader.readtext(str(image_path))
        
        # Extract all text and join
        full_text = ' '.join([detection[1] for detection in results])
        
        return {
            'image_path': str(image_path),
            'text': full_text,
            'words': [detection[1] for detection in results],
            'confidence': sum([detection[2] for detection in results]) / len(results) if results else 0
        }
    except Exception as e:
        return {
            'image_path': str(image_path),
            'text': '',
            'error': str(e)
        }
    finally:
        # Always restore output and clear buffers
        sys.stdout = _old_stdout
        sys.stderr = _old_stderr
        null_stdout.truncate(0)
        null_stderr.truncate(0)

def main():
    try:
        results = []
        for img_path in sys.argv[1:]:
            if not Path(img_path).exists():
                results.append({
                    'image_path': img_path,
                    'text': '',
                    'error': 'File not found'
                })
                continue
            
            result = extract_text(img_path)
            results.append(result)
        
        # Output only JSON to stdout
        print(json.dumps(results))
    except Exception:
        # Return error as JSON
        print(json.dumps([{'error': 'Failed to process images'}]))

if __name__ == "__main__":
    main()


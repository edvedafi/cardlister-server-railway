# Python Process Consolidation Plan

Prioritized by memory reduction to fix OOM-triggered SIGSEGV crashes.

## Implementation Status

- [x] Phase 1 (now priority 1): Merge orient_cards.py into ocr_extractor.py — saves ~300MB duplicate EasyOCR
- [x] Phase 1.5: Delete orient_cards.py (fully replaced by ocr_extractor.py worker), extract shared rotation utils into card_cropper_utils.py
- [ ] Phase 2 (now priority 2): Make card_cropper_sam.py a persistent worker — prevents 375MB transient spikes
- [ ] Phase 3 (now priority 3): Port card_extractor.py to TypeScript — removes persistent Python process
- [ ] Phase 4: Port card_cropper_ollama.py to TypeScript
- [ ] Phase 5: Evaluate and retire classical croppers

## Current State

6 Python scripts, 3 strategies (one-shot, persistent worker, HTTP wrapper), ~675MB+ combined model memory when all loaded. Several scripts are pure HTTP wrappers that don't need Python at all.

| Script | Strategy | Real Work | Python Needed? | Model Memory |
|--------|----------|-----------|----------------|-------------|
| card_extractor.py | Persistent worker | HTTP to Ollama/Claude API | No | ~0 |
| card_cropper_ollama.py | One-shot | HTTP to Ollama + cv2 crop | No | ~0 |
| card_cropper_yolo.py | One-shot | OpenCV edge detection | No | ~0 |
| card_cropper.py | One-shot | OpenCV edge detection | No | ~0 |
| ocr_extractor.py | Persistent worker | EasyOCR local inference + orientation | Yes | ~300MB |
| card_cropper_sam.py | One-shot | SAM local inference | Yes | ~375MB |
| card_cropper_utils.py | Shared module | Rotation/contour utilities | Yes | ~0 |

---

## Phase 1: Port card_extractor.py to TypeScript

**Effort:** Low (1-2 hours)
**Impact:** High -- eliminates a persistent Python subprocess that does zero local ML

### Why
`card_extractor.py` is a pure HTTP wrapper. It calls the Claude API via the `anthropic` Python SDK and Ollama via `urllib.request` POST to `localhost:11434`. The only image work is resizing with PIL before base64-encoding, which `sharp` already does elsewhere in the codebase.

### How
- Install `@anthropic-ai/sdk` (npm)
- Port the Claude Haiku call (~40 lines): send base64 images, parse JSON response
- Port the Ollama call (~30 lines): `fetch()` to `localhost:11434/api/chat`
- Port image resize/encode (~15 lines): `sharp` resize + `Buffer.toString('base64')`
- Keep the same request queue and retry logic already in `card-extractor.ts`
- Remove the persistent worker spawn/kill/readline machinery entirely
- The LRU cache can stay in TypeScript (simple `Map` with eviction)

### Key files
- Replace: `src/image-processing/card_extractor.py`
- Modify: `src/image-processing/card-extractor.ts` (inline the logic, remove subprocess management)
- Reference: `src/image-processing/chatgpt-processor.ts` (existing pattern for vision API calls from TS)

---

## Phase 2: Merge orient_cards.py into ocr_extractor.py as a single persistent EasyOCR worker

**Effort:** Low-Medium (2-3 hours)
**Impact:** High -- eliminates ~300MB duplicate model load, removes 3-10s startup per crop batch

### Why
Both scripts load the exact same EasyOCR model (`easyocr.Reader(['en'], gpu=False)`). `orient_cards.py` loads it fresh on every invocation (one-shot), paying 5-10s startup each time. `ocr_extractor.py` already runs as a persistent worker keeping the model warm. Merging orientation detection into the existing OCR worker means one model load serves both purposes.

### How
- Add an `orient` command to `ocr_extractor.py`'s worker protocol:
  ```
  Request:  {"cmd": "orient", "images": ["/path/to/img1.jpg", ...]}
  Response: [{"image_path": "...", "rotation_applied": 90, "confidence": 0.95}, ...]
  ```
- Move the orientation logic (test 4 rotations, pick highest OCR confidence) into `ocr_extractor.py`
- Update `card-cropper-wrapper.ts` `orientAndClassifyCards()` to call the OCR worker instead of spawning `orient_cards.py`
- Keep `orient_cards.py` around temporarily for standalone CLI use, but remove it from the pipeline

### Key files
- Modify: `src/image-processing/ocr_extractor.py` (add orient command)
- Modify: `src/image-processing/ocr-extractor.ts` (add `orientImages()` method)
- Modify: `src/image-processing/card-cropper-wrapper.ts` (call OCR worker instead of spawning orient_cards.py)
- Retire: `src/image-processing/orient_cards.py` (keep for CLI, remove from pipeline)

---

## Phase 3: Port card_cropper_ollama.py to TypeScript

**Effort:** Low-Medium (2-3 hours)
**Impact:** Medium -- eliminates another Python subprocess, simplifies cropping fallback

### Why
This script makes an HTTP POST to Ollama asking for bounding box coordinates, then uses cv2 for rotation and cropping. The HTTP call is trivial in JS. The cv2 operations (minAreaRect rotation, warpAffine, crop) can be handled by `sharp` for the common cases.

### How
- Port the Ollama HTTP call: `fetch()` to `localhost:11434/api/chat` with base64 image
- Port bbox parsing: JSON parsing + coordinate validation (pure logic, no dependencies)
- Port rotation/crop: `sharp.rotate()` + `sharp.extract()` for axis-aligned crops
- For the edge refinement fallback (CLAHE + Canny): evaluate if it's actually triggered often enough to port, or if SAM covers those cases

### Key files
- Replace: `src/image-processing/card_cropper_ollama.py`
- Modify: `src/image-processing/card-cropper-wrapper.ts` (inline the logic)

---

## Phase 4: Evaluate and retire classical croppers (card_cropper_yolo.py, card_cropper.py)

**Effort:** Low (1 hour investigation + removal)
**Impact:** Medium -- reduces codebase complexity, fewer Python dependencies

### Why
These are classical OpenCV edge detection approaches (Canny, contours, Hough lines, perspective transform) that predate the SAM and Ollama croppers. If SAM + Ollama fallback covers all real-world cases, these are dead code adding maintenance burden.

### How
- Check usage: grep for `cropCardsWithPython` and `cropCardsWithYOLO` calls in the codebase
- Review `imageProcessor.js` fallback chain to see if these are still reached
- If SAM + Ollama handle all cases: remove the scripts and their wrapper functions
- If edge cases remain: port to `opencv4nodejs` or `sharp` if needed, or keep as last-resort fallback

### Key files
- Evaluate: `src/image-processing/imageProcessor.js` (fallback chain)
- Evaluate: `src/image-processing/card-cropper-wrapper.ts` (which functions are called)
- Potentially remove: `src/image-processing/card_cropper_yolo.py`, `src/image-processing/card_cropper.py`

---

## Phase 5: Make card_cropper_sam.py a persistent worker

**Effort:** Medium (3-4 hours)
**Impact:** Medium -- eliminates 2-3s model reload per batch, keeps ~375MB loaded once

### Why
SAM is the primary cropper and currently reloads the 375MB model on every invocation. In watch mode processing many cards, this adds up. The model should load once and stay warm like the OCR worker.

### How
- Add a stdin/stdout JSON worker protocol to `card_cropper_sam.py` (same pattern as `ocr_extractor.py`)
- Create `sam-cropper.ts` wrapper with spawn/kill/readline (copy pattern from `ocr-extractor.ts`)
- Update `card-cropper-wrapper.ts` to use the persistent worker
- Keep CLI mode for standalone use

### Key files
- Modify: `src/image-processing/card_cropper_sam.py` (add worker mode)
- Create: `src/image-processing/sam-cropper.ts` (persistent worker wrapper)
- Modify: `src/image-processing/card-cropper-wrapper.ts` (use worker)

---

## End State

After all phases:

| Component | Language | Strategy | Model Memory |
|-----------|----------|----------|-------------|
| Card info extraction | TypeScript | Direct HTTP (no subprocess) | 0 |
| EasyOCR (orientation + text) | Python | Single persistent worker | ~300MB |
| SAM cropping | Python | Persistent worker | ~375MB |
| Ollama cropping fallback | TypeScript | Direct HTTP (no subprocess) | 0 |
| Classical croppers | Removed or TS | N/A | 0 |

- Python subprocesses: 2 (down from 7)
- Total model memory: ~675MB (down from ~975MB with duplicate EasyOCR)
- No more one-shot Python scripts paying model load costs per invocation
- No more Python wrappers around HTTP calls that JS can make directly

# Cost-Effective OCR Solution

This provides a **free alternative** to Google Cloud Vision API for extracting text from card images.

## Setup

1. Install EasyOCR:
```bash
pip install easyocr
```

2. Install the TypeScript wrapper:
```typescript
import { extractTextFromImages } from './image-processing/ocr-extractor.js';
```

## Usage

### As a direct replacement for Google Vision:

Instead of:
```typescript
const [frontResult] = await client.annotateImage({
  image: { source: { filename: front } },
  features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
});
const frontText = frontResult.textAnnotations?.[0]?.description?.toLowerCase() || '';
```

Use:
```typescript
import { extractTextFromImages } from './image-processing/ocr-extractor.js';

const results = await extractTextWithOCR([front, back]);
const frontText = results[0].text.toLowerCase();
const backText = results[1]?.text.toLowerCase() || '';
```

## Cost Comparison

| Solution | Cost | Speed | Accuracy |
|----------|------|-------|----------|
| **Google Cloud Vision** | $1.50 per 1,000 images | Fast (API) | Excellent |
| **EasyOCR** | **$0** | Slower (local) | Very Good |
| **Tesseract** | **$0** | Fast | Good |
| **PaddleOCR** | **$0** | Medium | Excellent |

## Performance Notes

- **First run**: EasyOCR downloads models (~200MB), takes 10-30 seconds
- **Subsequent runs**: Fast (uses cached models)
- **GPU**: 3-5x faster if you have CUDA support

## Recommended Approach

For **development/testing**: Use EasyOCR (free)  
For **production/high-volume**: Consider Google Vision API for speed

## Configuration

You can switch between OCR solutions by modifying `matchProductFromOCR` in `imageRecognition.ts`:

```typescript
// Use EasyOCR (free)
const { extractTextWithOCR } = await import('./image-processing/ocr-extractor.js');
const results = await extractTextWithOCR([front, back]);

// OR use Google Vision (paid)
const client = new vision.ImageAnnotatorClient();
const [result] = await client.annotateImage({...});
```


import { $ } from 'zx';
import path from 'path';
import { fileURLToPath } from 'url';
import { orientImages, type OrientResult } from './ocr-extractor.js';
import { getCardExtractorBackend } from './card-extractor.js';
import { cropImagesWithSAMWorker } from './sam-cropper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache orient results from crop functions so the subsequent autoOrient step
// can return them instantly instead of re-running EasyOCR on already-oriented images.
const orientCache = new Map<string, OrientResult>();

// Use the project venv's Python interpreter so all packages (transformers, cv2, etc.) are available
const VENV_PYTHON = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');

type CardCropResult = {
  success: boolean;
  image_path: string;
  error?: string;
  cards?: Array<{
    original_path: string;
    cropped_path: string;
    coordinates: number[][];
    confidence: number;
  }>;
};

/**
 * @deprecated UNUSED — superseded by the preprocess service `/crop` endpoint
 * (`cropAlternativesRemote` in remote-image-service.ts). Kept temporarily
 * while the new path is being validated; delete once the rollout sticks.
 *
 * Calls the Python card_cropper script with a list of image paths, and returns the array of output image paths.
 * @param imagePaths Array of input image file paths
 * @returns Promise<string[]> Array of output (cropped) image paths
 */
export async function cropCardsWithPython(imagePaths: string[], outputDir: string = 'input/tmp'): Promise<string[]> {
  const scriptPath = path.join(__dirname, 'card_cropper_yolo.py');
  // Ensure all image paths are absolute
  const absImagePaths = imagePaths.map(p => path.isAbsolute(p) ? p : path.resolve(p));
  try {
    const yoloProc = $`${VENV_PYTHON} ${scriptPath} ${outputDir} ${absImagePaths}`;
    yoloProc.quiet();
    const { stdout } = await yoloProc;
    // card_cropper_yolo.py prints a JSON array of output image paths
    const paths: string[] = JSON.parse(stdout.trim());
    await orientCroppedCards(paths);
    return paths;
  } catch (err: any) {
    // zx throws with stderr and stdout attached
    throw new Error(`card_cropper_yolo.py failed: ${err.stderr || err.message}`);
  }
}

/**
 * @deprecated UNUSED — SAM cropping now runs on the preprocess service via
 * `/crop` (`cropAlternativesRemote` in remote-image-service.ts). Kept
 * temporarily while the new path is being validated; delete once the
 * rollout sticks.
 *
 * Crop cards using SAM2 (primary) with Ollama vision as per-image fallback.
 *
 * SAM2 uses semantic segmentation, making it robust to black-edged cards on black
 * backdrops where classical edge detection fails. After locating the card, the image
 * is rotated so the card's edges are perfectly horizontal/vertical before cropping.
 *
 * Requires: pip install transformers accelerate  (already in venv)
 * Requires: Ollama running at localhost:11434 with llama3.2-vision:11b (for fallback)
 *
 * @param imagePaths Array of input image file paths
 * @param outputDir  Directory for cropped output images
 * @returns Promise<string[]> Array of cropped image paths (one per successful card)
 */
export async function cropCardsWithSAM(
  imagePaths: string[],
  outputDir: string = 'input/tmp',
): Promise<string[]> {
  const absImagePaths = imagePaths.map(p => path.isAbsolute(p) ? p : path.resolve(p));
  const absOutputDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(outputDir);

  const ollamaScript = path.join(__dirname, 'card_cropper_ollama.py');

  // Ollama fallback still uses the one-shot spawn pattern (Phase 4 will port
  // this to TypeScript and remove the subprocess).
  async function runOllamaFallback(paths: string[]): Promise<CardCropResult[]> {
    const proc = $`${VENV_PYTHON} ${ollamaScript} ${absOutputDir} ${paths}`;
    proc.quiet();
    const { stdout } = await proc;
    return JSON.parse(stdout.trim()) as CardCropResult[];
  }

  let results: CardCropResult[];

  // --- Primary: persistent SAM worker ---
  try {
    results = await cropImagesWithSAMWorker(absImagePaths, absOutputDir);
  } catch (samErr: any) {
    try {
      results = await runOllamaFallback(absImagePaths);
    } catch (ollamaErr: any) {
      throw new Error(
        `Both SAM and Ollama card croppers failed.\n` +
        `SAM: ${samErr.stderr || samErr.message}\n` +
        `Ollama: ${ollamaErr.stderr || ollamaErr.message}`,
      );
    }
    const paths = extractCroppedPaths(results);
    await orientCroppedCards(paths);
    return paths;
  }

  // --- Per-image fallback: retry failed images with Ollama ---
  const failedIndices = results.reduce<number[]>((acc, r, i) => {
    if (!r.success) acc.push(i);
    return acc;
  }, []);

  if (failedIndices.length > 0) {
    const failedPaths = failedIndices.map(i => absImagePaths[i]);
    try {
      const ollamaResults = await runOllamaFallback(failedPaths);
      for (let j = 0; j < failedIndices.length; j++) {
        results[failedIndices[j]] = ollamaResults[j];
      }
    } catch {
      // Leave SAM failures in place; extractCroppedPaths will skip them
    }
  }

  const finalPaths = extractCroppedPaths(results);
  await orientCroppedCards(finalPaths);
  return finalPaths;
}

/**
 * @deprecated UNUSED — Ollama bbox cropping now runs on the preprocess
 * service via `/crop` (`cropAlternativesRemote` in remote-image-service.ts).
 * Kept temporarily while the new path is being validated; delete once the
 * rollout sticks.
 *
 * Crop cards using Ollama vision model directly (no SAM involvement).
 *
 * Sends each image to the local Ollama llama3.2-vision model, which returns a
 * bounding box that is then refined with edge detection for rotation correction.
 *
 * Requires: Ollama running at localhost:11434 with llama3.2-vision:11b
 *
 * @param imagePaths Array of input image file paths
 * @param outputDir  Directory for cropped output images
 * @returns Promise<string[]> Array of cropped image paths (one per successful card)
 */
export async function cropCardsWithOllama(
  imagePaths: string[],
  outputDir: string = 'input/tmp',
): Promise<string[]> {
  const absImagePaths = imagePaths.map(p => path.isAbsolute(p) ? p : path.resolve(p));
  const absOutputDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(outputDir);

  const ollamaScript = path.join(__dirname, 'card_cropper_ollama.py');

  try {
    const ollamaProc = $`${VENV_PYTHON} ${ollamaScript} ${absOutputDir} ${absImagePaths}`;
    ollamaProc.quiet();
    const { stdout } = await ollamaProc;
    const results = JSON.parse(stdout.trim()) as CardCropResult[];
    const paths = extractCroppedPaths(results);
    await orientCroppedCards(paths);
    return paths;
  } catch (err: any) {
    throw new Error(`card_cropper_ollama.py failed: ${err.stderr || err.message}`);
  }
}

/**
 * Post-crop orientation correction: rotates cropped card images so text reads right-side-up.
 * Uses the persistent EasyOCR worker (shared with OCR extraction) to avoid loading
 * a duplicate ~300MB model.
 *
 * Set SKIP_ORIENTATION_CORRECTION=1 to bypass this step.
 */
async function orientCroppedCards(croppedPaths: string[]): Promise<void> {
  if (croppedPaths.length === 0) return;
  if (process.env.SKIP_ORIENTATION_CORRECTION === '1') return;
  // In haiku mode, orientation is handled by the Haiku extraction call — skip EasyOCR
  if (getCardExtractorBackend() === 'haiku') return;

  try {
    const results = await orientImages(croppedPaths);
    // Cache results so the subsequent autoOrient step can skip re-running EasyOCR
    for (let i = 0; i < results.length && i < croppedPaths.length; i++) {
      const absPath = path.isAbsolute(croppedPaths[i]) ? croppedPaths[i] : path.resolve(croppedPaths[i]);
      orientCache.set(absPath, results[i]);
    }
  } catch {
    // Orientation correction is best-effort — don't fail the whole crop pipeline
  }
}

/**
 * Batch pre-processing step: fix orientation on all images and return orient results
 * for front/back classification. Call this BEFORE pairing images.
 *
 * Uses the persistent EasyOCR worker to avoid spawning a separate process.
 *
 * @returns Map from image path to OrientResult
 */
export async function orientAndClassifyCards(imagePaths: string[]): Promise<Map<string, OrientResult>> {
  const resultMap = new Map<string, OrientResult>();
  if (imagePaths.length === 0) return resultMap;
  if (process.env.SKIP_ORIENTATION_CORRECTION === '1') return resultMap;
  // In haiku mode, orientation is handled by the Haiku extraction call — skip EasyOCR
  if (getCardExtractorBackend() === 'haiku') return resultMap;

  const absPaths = imagePaths.map(p => path.isAbsolute(p) ? p : path.resolve(p));

  // Check cache first — images already oriented during crop don't need re-processing
  const uncachedPaths: string[] = [];
  const uncachedOrigPaths: string[] = [];
  for (let i = 0; i < absPaths.length; i++) {
    const cached = orientCache.get(absPaths[i]);
    if (cached) {
      resultMap.set(imagePaths[i], cached);
      orientCache.delete(absPaths[i]);
    } else {
      uncachedPaths.push(absPaths[i]);
      uncachedOrigPaths.push(imagePaths[i]);
    }
  }

  // Only call Python for images not already in the cache
  if (uncachedPaths.length > 0) {
    try {
      const results = await orientImages(uncachedPaths);
      for (let i = 0; i < results.length && i < uncachedOrigPaths.length; i++) {
        resultMap.set(uncachedOrigPaths[i], results[i]);
      }
    } catch {
      // Best-effort — return what we have from cache, caller falls back for the rest
    }
  }

  return resultMap;
}

/**
 * Given two images from a pair, return [front, back] based on text detection counts.
 * The image with MORE text is the back (stats, bio, copyright).
 * If counts are equal or unavailable, keeps original order.
 */
export function orderFrontBack(
  imageA: string,
  imageB: string,
  orientResults: Map<string, OrientResult>,
): [front: string, back: string] {
  const countA = orientResults.get(imageA)?.text_detection_count ?? 0;
  const countB = orientResults.get(imageB)?.text_detection_count ?? 0;

  if (countA > countB) {
    // A has more text → A is the back
    return [imageB, imageA];
  }
  // B has more text or equal → keep original order (A is front)
  return [imageA, imageB];
}


function extractCroppedPaths(results: CardCropResult[]): string[] {
  const paths: string[] = [];
  for (const result of results) {
    if (result.success && result.cards) {
      for (const card of result.cards) {
        paths.push(card.cropped_path);
      }
    }
  }
  return paths;
}

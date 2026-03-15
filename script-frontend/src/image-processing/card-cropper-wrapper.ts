import { $ } from 'zx';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Calls the Python card_cropper script with a list of image paths, and returns the array of output image paths.
 * @param imagePaths Array of input image file paths
 * @returns Promise<string[]> Array of output (cropped) image paths
 */
export async function cropCardsWithPython(imagePaths: string[], outputDir: string = 'input/tmp'): Promise<string[]> {
  console.log('Running card_cropper_yolo.py with args:', imagePaths);
  const scriptPath = path.join(__dirname, 'card_cropper_yolo.py');
  // Ensure all image paths are absolute
  const absImagePaths = imagePaths.map(p => path.isAbsolute(p) ? p : path.resolve(p));
  try {
    const { stdout } = await $`python3 ${scriptPath} ${outputDir} ${absImagePaths}`;
    // card_cropper_yolo.py prints a JSON array of output image paths
    return JSON.parse(stdout.trim());
  } catch (err: any) {
    // zx throws with stderr and stdout attached
    throw new Error(`card_cropper_yolo.py failed: ${err.stderr || err.message}`);
  }
}

/**
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

  const samScript = path.join(__dirname, 'card_cropper_sam.py');
  const ollamaScript = path.join(__dirname, 'card_cropper_ollama.py');

  async function runScript(scriptPath: string, paths: string[]): Promise<CardCropResult[]> {
    const { stdout } = await $`${VENV_PYTHON} ${scriptPath} ${absOutputDir} ${paths}`;
    return JSON.parse(stdout.trim()) as CardCropResult[];
  }

  let results: CardCropResult[];

  // --- Primary: SAM ---
  try {
    console.log('[card-cropper] Running SAM card cropper...');
    results = await runScript(samScript, absImagePaths);
  } catch (samErr: any) {
    console.error('[card-cropper] SAM failed entirely, falling back to Ollama:', samErr.stderr || samErr.message);
    try {
      results = await runScript(ollamaScript, absImagePaths);
    } catch (ollamaErr: any) {
      throw new Error(
        `Both SAM and Ollama card croppers failed.\n` +
        `SAM: ${samErr.stderr || samErr.message}\n` +
        `Ollama: ${ollamaErr.stderr || ollamaErr.message}`,
      );
    }
    return extractCroppedPaths(results);
  }

  // --- Per-image fallback: retry failed images with Ollama ---
  const failedIndices = results.reduce<number[]>((acc, r, i) => {
    if (!r.success) acc.push(i);
    return acc;
  }, []);

  if (failedIndices.length > 0) {
    console.log(`[card-cropper] ${failedIndices.length} image(s) failed SAM; retrying with Ollama...`);
    const failedPaths = failedIndices.map(i => absImagePaths[i]);
    try {
      const ollamaResults = await runScript(ollamaScript, failedPaths);
      for (let j = 0; j < failedIndices.length; j++) {
        results[failedIndices[j]] = ollamaResults[j];
      }
    } catch (e) {
      // Leave SAM failures in place; extractCroppedPaths will skip them
      console.error('[card-cropper] Ollama per-image fallback also failed:', e);
    }
  }

  return extractCroppedPaths(results);
}

/**
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

  console.log('[card-cropper] Running Ollama card cropper...');
  try {
    const { stdout } = await $`${VENV_PYTHON} ${ollamaScript} ${absOutputDir} ${absImagePaths}`;
    const results = JSON.parse(stdout.trim()) as CardCropResult[];
    return extractCroppedPaths(results);
  } catch (err: any) {
    throw new Error(`card_cropper_ollama.py failed: ${err.stderr || err.message}`);
  }
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

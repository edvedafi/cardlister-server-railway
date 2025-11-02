import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type OCRExtractResult = {
  image_path: string;
  text: string;
  words?: string[];
  confidence?: number;
  error?: string;
};

/**
 * Extract text from images using EasyOCR (cost-effective alternative to Google Vision)
 * @param imagePaths - Array of image paths to extract text from
 * @returns Array of extracted text results
 */
export async function extractTextWithOCR(imagePaths: string[]): Promise<OCRExtractResult[]> {
  const scriptPath = path.join(__dirname, 'ocr_extractor.py');
  const venvPython = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');

  const threads = process.env.OCR_THREADS || '8'; // allow user to configure, default higher for speed

  return await new Promise<OCRExtractResult[]>((resolve, reject) => {
    // Build args
    const args = [scriptPath, ...imagePaths];

    const child = spawn(venvPython, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Allow multi-threaded backends to utilize more cores while leaving some headroom
        OMP_NUM_THREADS: threads,
        MKL_NUM_THREADS: threads,
        OPENBLAS_NUM_THREADS: threads,
        NUMEXPR_NUM_THREADS: threads,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      // Collect but don't spam console; helps with debugging without blocking
      stderr += chunk;
    });

    child.on('error', (err) => reject(new Error(`Failed to start OCR process: ${err.message}`)));

    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout) as OCRExtractResult[]);
        } catch (e) {
          reject(new Error(`Failed to parse OCR output: ${(e as Error).message}\nOutput: ${stdout}\nStderr: ${stderr}`));
        }
      } else {
        reject(new Error(`OCR process exited with code ${code}.\nStderr: ${stderr}`));
      }
    });
  });
}

/**
 * Extract text from a single image
 * @param imagePath - Path to the image
 * @returns Extracted text and metadata
 */
export async function extractTextFromImage(imagePath: string): Promise<OCRExtractResult> {
  const results = await extractTextWithOCR([imagePath]);
  return results[0];
}

/**
 * Get combined text from multiple images
 * @param imagePaths - Array of image paths
 * @returns Combined text from all images
 */
export async function extractTextFromImages(imagePaths: string[]): Promise<string> {
  const results = await extractTextWithOCR(imagePaths);
  return results.map(r => r.text).join(' ');
}


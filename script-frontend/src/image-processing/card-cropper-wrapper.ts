import { $ } from 'zx';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

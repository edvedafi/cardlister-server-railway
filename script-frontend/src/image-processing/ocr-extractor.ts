import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type OCRExtractResult = {
  image_path: string;
  text: string;
  words?: string[];
  confidence?: number;
  error?: string;
};

export type OrientResult = {
  image_path: string;
  rotation_applied: number;
  confidence: number;
  text_detection_count: number;
  scores: Record<string, number>;
  error?: string;
};

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const RESTART_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min per request (model init on first call can be slow)
const WORKER_STARTUP_TIMEOUT_MS = 180_000; // 3 min max for model load

// ── Persistent OCR worker management ────────────────────────────────────────

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let readline: ReadlineInterface | null = null;
let spawnPromise: Promise<void> | null = null;

/** Queue to serialize requests to the worker (only one in-flight at a time). */
type QueuedRequest = {
  payload: object;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
};
const requestQueue: QueuedRequest[] = [];
let activeRequest: QueuedRequest | null = null;

function getEnv(): NodeJS.ProcessEnv {
  const threads = process.env.OCR_THREADS || '2';
  return {
    ...process.env,
    // Limit BLAS / OpenMP threads to reduce memory footprint
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    // Prevent PyTorch from caching freed allocations (reduces peak memory)
    PYTORCH_NO_CUDA_MEMORY_CACHING: '1',
    // Disable macOS nano-zone allocator – known to interact badly with the
    // Tahoe memory-compressor bug that causes SIGBUS crashes.
    MALLOC_NANO_ZONE: '0',
    // macOS Tahoe: Objective-C runtime crashes in subprocess when ObjC frameworks
    // (used internally by PyTorch/MPS) are initialized across fork boundaries.
    OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES',
  };
}

/**
 * Spawn (or re-spawn) the persistent Python OCR worker.
 * Resolves once the worker prints its {"status":"ready"} line.
 */
function spawnWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'ocr_extractor.py');
    const venvPython = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');

    // Kill any lingering process
    killWorker();

    const child = spawn(venvPython, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getEnv(),
    });

    worker = child;
    workerReady = false;

    // Accumulate stderr so we can log it if the worker crashes unexpectedly
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      // Keep last 4 KB to avoid unbounded growth
      if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
    });

    const rl = createInterface({ input: child.stdout });
    readline = rl;

    // First line must be the {"status":"ready"} handshake
    let gotReady = false;

    // Reject if the worker never emits ready (e.g. crashes during model load)
    const startupTimer = setTimeout(() => {
      if (!gotReady) {
        killWorker();
        reject(new Error('OCR worker startup timed out'));
      }
    }, WORKER_STARTUP_TIMEOUT_MS);

    rl.on('line', (line: string) => {
      if (!gotReady) {
        // Consume the ready signal
        try {
          const msg = JSON.parse(line);
          if (msg?.status === 'ready') {
            gotReady = true;
            workerReady = true;
            clearTimeout(startupTimer);
            resolve();
            return;
          }
        } catch {
          // ignore non-JSON during startup
        }
        return;
      }

      // Subsequent lines are responses to requests
      if (activeRequest) {
        const req = activeRequest;
        activeRequest = null;
        req.resolve(line);
        // Process next queued request
        processNextRequest();
      }
    });

    child.on('error', (err) => {
      workerReady = false;
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`Failed to start OCR worker: ${err.message}`));
      }
      rejectPending(new Error(`OCR worker error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      workerReady = false;
      worker = null;
      readline = null;
      if (code !== 0 || signal) {
        console.error(`[OCR worker] exited code=${code} signal=${signal}`);
        if (stderrBuffer.trim()) {
          console.error('[OCR worker stderr]:\n' + stderrBuffer.trim());
        }
      }
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`OCR worker exited during startup (code=${code}, signal=${signal})`));
      }
      rejectPending(new Error(`OCR worker crashed (code=${code}, signal=${signal})`));
    });
  });
}

function killWorker() {
  if (worker) {
    try {
      worker.stdin.end();
      worker.kill();
    } catch {
      // already dead
    }
    worker = null;
    workerReady = false;
    readline = null;
  }
}

function rejectPending(err: Error) {
  // Reject the active request
  if (activeRequest) {
    const req = activeRequest;
    activeRequest = null;
    req.reject(err);
  }
  // Reject all queued requests
  while (requestQueue.length > 0) {
    const req = requestQueue.shift()!;
    req.reject(err);
  }
}

/**
 * Ensure the worker is alive and ready. Spawns it on first call or after a crash.
 */
async function ensureWorker(): Promise<void> {
  if (worker && workerReady) return;
  if (!spawnPromise) {
    spawnPromise = spawnWorker().finally(() => {
      spawnPromise = null;
    });
  }
  await spawnPromise;
}

/**
 * Flush the next queued request to the worker's stdin.
 * Only called when no request is currently in-flight.
 */
function processNextRequest(): void {
  if (activeRequest || requestQueue.length === 0) return;
  if (!worker || !workerReady) {
    // Reject everything – caller will restart the worker and retry
    while (requestQueue.length > 0) {
      const req = requestQueue.shift()!;
      req.reject(new Error('OCR worker not ready'));
    }
    return;
  }

  const req = requestQueue.shift()!;
  activeRequest = req;

  const line = JSON.stringify(req.payload) + '\n';
  worker.stdin.write(line, (err) => {
    if (err) {
      activeRequest = null;
      req.reject(new Error(`Failed to write to OCR worker: ${err.message}`));
      // Try the next request
      processNextRequest();
    }
  });
}

/**
 * Send a single request to the worker and wait for the response line.
 * Requests are serialized so only one is in-flight at a time.
 */
function sendRequest(payload: object): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!worker || !workerReady) {
      reject(new Error('OCR worker not ready'));
      return;
    }

    requestQueue.push({ payload, resolve, reject });

    // If nothing is in-flight, kick off processing immediately
    if (!activeRequest) {
      processNextRequest();
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract text from images using the persistent EasyOCR worker.
 * Automatically (re)starts the worker and retries on transient crashes.
 * @param imagePaths - Array of image paths to extract text from
 * @returns Array of extracted text results
 */
export async function extractTextWithOCR(imagePaths: string[]): Promise<OCRExtractResult[]> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ensureWorker();

      // Race the request against a timeout
      const responseLine = await Promise.race([
        sendRequest({ images: imagePaths }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('OCR request timed out')), REQUEST_TIMEOUT_MS),
        ),
      ]);

      return JSON.parse(responseLine) as OCRExtractResult[];
    } catch (err) {
      lastError = err as Error;

      // If the worker crashed, kill it so ensureWorker will restart on next attempt
      killWorker();

      // Don't retry if we can't even start the process
      if (lastError.message.startsWith('Failed to start OCR worker')) {
        throw lastError;
      }

      // Brief pause before retry to let memory pressure subside
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RESTART_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError!;
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
  return results.map((r) => r.text).join(' ');
}

/**
 * Detect and correct orientation of cropped card images using the persistent
 * EasyOCR worker. Images are rotated in-place if needed.
 *
 * This replaces the standalone orient_cards.py script, avoiding a duplicate
 * ~300MB EasyOCR model load.
 */
export async function orientImages(imagePaths: string[]): Promise<OrientResult[]> {
  if (imagePaths.length === 0) return [];

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ensureWorker();

      const responseLine = await Promise.race([
        sendRequest({ cmd: 'orient', images: imagePaths }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Orient request timed out')), REQUEST_TIMEOUT_MS),
        ),
      ]);

      return JSON.parse(responseLine) as OrientResult[];
    } catch (err) {
      lastError = err as Error;
      killWorker();

      if (lastError.message.startsWith('Failed to start OCR worker')) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RESTART_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError!;
}

/**
 * Gracefully shut down the OCR worker. Call this when your app is exiting.
 */
export function shutdownOCR(): void {
  if (worker && workerReady) {
    try {
      worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {
      // ignore
    }
  }
  killWorker();
}

// Clean up on process exit
process.on('exit', () => killWorker());
process.on('SIGINT', () => {
  killWorker();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killWorker();
  process.exit(143);
});
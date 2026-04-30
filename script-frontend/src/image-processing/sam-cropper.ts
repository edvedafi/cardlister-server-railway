import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type SAMCropResult = {
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

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const RESTART_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min per crop request
const WORKER_STARTUP_TIMEOUT_MS = 180_000; // 3 min max for model load

// ── Persistent SAM worker management ────────────────────────────────────────

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let readline: ReadlineInterface | null = null;
let spawnPromise: Promise<void> | null = null;

type QueuedRequest = {
  payload: object;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
};
const requestQueue: QueuedRequest[] = [];
let activeRequest: QueuedRequest | null = null;

function getEnv(): NodeJS.ProcessEnv {
  const threads = process.env.SAM_THREADS || '2';
  return {
    ...process.env,
    // Limit BLAS / OpenMP threads to reduce memory footprint
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    // Prevent PyTorch from caching freed allocations (reduces peak memory)
    PYTORCH_NO_CUDA_MEMORY_CACHING: '1',
    // Disable macOS nano-zone allocator — known to interact badly with the
    // Tahoe memory-compressor bug that causes SIGBUS crashes.
    MALLOC_NANO_ZONE: '0',
    // macOS Tahoe: Objective-C runtime crashes in subprocess when ObjC frameworks
    // (used internally by PyTorch/MPS) are initialized across fork boundaries.
    OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES',
  };
}

/**
 * Spawn (or re-spawn) the persistent Python SAM worker.
 * Resolves once the worker prints its {"status":"ready"} line.
 */
function spawnWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'card_cropper_sam.py');
    const venvPython = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');

    killWorker();

    const child = spawn(venvPython, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getEnv(),
    });

    worker = child;
    workerReady = false;

    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
    });

    const rl = createInterface({ input: child.stdout });
    readline = rl;

    let gotReady = false;

    const startupTimer = setTimeout(() => {
      if (!gotReady) {
        killWorker();
        reject(new Error('SAM worker startup timed out'));
      }
    }, WORKER_STARTUP_TIMEOUT_MS);

    rl.on('line', (line: string) => {
      if (!gotReady) {
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
          // ignore non-JSON chatter during startup
        }
        return;
      }

      if (activeRequest) {
        const req = activeRequest;
        activeRequest = null;
        req.resolve(line);
        processNextRequest();
      }
    });

    child.on('error', (err) => {
      workerReady = false;
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`Failed to start SAM worker: ${err.message}`));
      }
      rejectPending(new Error(`SAM worker error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      workerReady = false;
      worker = null;
      readline = null;
      if (code !== 0 || signal) {
        console.error(`[SAM worker] exited code=${code} signal=${signal}`);
        if (stderrBuffer.trim()) {
          console.error('[SAM worker stderr]:\n' + stderrBuffer.trim());
        }
      }
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`SAM worker exited during startup (code=${code}, signal=${signal})`));
      }
      rejectPending(new Error(`SAM worker crashed (code=${code}, signal=${signal})`));
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
  if (activeRequest) {
    const req = activeRequest;
    activeRequest = null;
    req.reject(err);
  }
  while (requestQueue.length > 0) {
    const req = requestQueue.shift()!;
    req.reject(err);
  }
}

async function ensureWorker(): Promise<void> {
  if (worker && workerReady) return;
  if (!spawnPromise) {
    spawnPromise = spawnWorker().finally(() => {
      spawnPromise = null;
    });
  }
  await spawnPromise;
}

function processNextRequest(): void {
  if (activeRequest || requestQueue.length === 0) return;
  if (!worker || !workerReady) {
    while (requestQueue.length > 0) {
      const req = requestQueue.shift()!;
      req.reject(new Error('SAM worker not ready'));
    }
    return;
  }

  const req = requestQueue.shift()!;
  activeRequest = req;

  const line = JSON.stringify(req.payload) + '\n';
  worker.stdin.write(line, (err) => {
    if (err) {
      activeRequest = null;
      req.reject(new Error(`Failed to write to SAM worker: ${err.message}`));
      processNextRequest();
    }
  });
}

function sendRequest(payload: object): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!worker || !workerReady) {
      reject(new Error('SAM worker not ready'));
      return;
    }

    requestQueue.push({ payload, resolve, reject });

    if (!activeRequest) {
      processNextRequest();
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Crop a batch of card images using the persistent SAM worker.
 * The SAM model is loaded once on first use and kept warm — no more ~375MB
 * reload per call. Automatically re-spawns the worker on crash.
 *
 * @param imagePaths - Absolute image paths to crop
 * @param outputDir  - Absolute directory to write cropped images into
 */
export async function cropImagesWithSAMWorker(
  imagePaths: string[],
  outputDir: string,
): Promise<SAMCropResult[]> {
  if (imagePaths.length === 0) return [];

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ensureWorker();

      const responseLine = await Promise.race([
        sendRequest({ cmd: 'crop', paths: imagePaths, output_dir: outputDir }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SAM request timed out')), REQUEST_TIMEOUT_MS),
        ),
      ]);

      return JSON.parse(responseLine) as SAMCropResult[];
    } catch (err) {
      lastError = err as Error;

      // Kill the worker so ensureWorker restarts it on the next attempt
      killWorker();

      if (lastError.message.startsWith('Failed to start SAM worker')) {
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
 * Gracefully shut down the SAM worker. Call from process shutdown.
 */
export function shutdownSAMCropper(): void {
  if (worker && workerReady) {
    try {
      worker.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {
      // ignore
    }
  }
  killWorker();
}

process.on('exit', () => killWorker());
process.on('SIGINT', () => {
  killWorker();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killWorker();
  process.exit(143);
});

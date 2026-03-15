import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type CardExtractResult = {
  player: string | null;
  team: string | null;
  card_number: string | null;
  error?: string;
};

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const RESTART_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min (first call loads model)
const WORKER_STARTUP_TIMEOUT_MS = 60_000; // 1 min to emit ready

// ── Persistent worker management ─────────────────────────────────────────────

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
  return {
    ...process.env,
    // Default to local Ollama if OLLAMA_HOST not already set
    OLLAMA_HOST: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    // Suppress Python warnings
    PYTHONWARNINGS: 'ignore',
  };
}

function spawnWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'card_extractor.py');
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
        reject(new Error('Card extractor worker startup timed out'));
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
          // ignore non-JSON during startup
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
        reject(new Error(`Failed to start card extractor worker: ${err.message}`));
      }
      rejectPending(new Error(`Card extractor worker error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      workerReady = false;
      worker = null;
      readline = null;
      if (code !== 0 || signal) {
        console.error(`[card-extractor] exited code=${code} signal=${signal}`);
        if (stderrBuffer.trim()) {
          console.error('[card-extractor stderr]:\n' + stderrBuffer.trim());
        }
      }
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`Card extractor worker exited during startup (code=${code}, signal=${signal})`));
      }
      rejectPending(new Error(`Card extractor worker crashed (code=${code}, signal=${signal})`));
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
    requestQueue.shift()!.reject(err);
  }
}

async function ensureWorker(): Promise<void> {
  if (worker && workerReady) return;
  // Deduplicate concurrent spawn attempts: if one is already in progress, wait for it
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
      requestQueue.shift()!.reject(new Error('Card extractor worker not ready'));
    }
    return;
  }

  const req = requestQueue.shift()!;
  activeRequest = req;

  worker.stdin.write(JSON.stringify(req.payload) + '\n', (err) => {
    if (err) {
      activeRequest = null;
      req.reject(new Error(`Failed to write to card extractor: ${err.message}`));
      processNextRequest();
    }
  });
}

function sendRequest(payload: object): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!worker || !workerReady) {
      reject(new Error('Card extractor worker not ready'));
      return;
    }
    requestQueue.push({ payload, resolve, reject });
    if (!activeRequest) processNextRequest();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract player, team, and card number from a card image pair.
 * Uses Ollama (if OLLAMA_HOST is set) or Claude Haiku 4.5 as the backend.
 * Automatically starts and manages the persistent Python worker.
 */
export async function extractCardInfo(
  frontPath: string,
  backPath: string,
): Promise<CardExtractResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ensureWorker();

      const responseLine = await Promise.race([
        sendRequest({ front: frontPath, back: backPath }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Card extractor request timed out')), REQUEST_TIMEOUT_MS),
        ),
      ]);

      const result = JSON.parse(responseLine) as CardExtractResult;
      if (result.error) throw new Error(result.error);
      return result;
    } catch (err) {
      lastError = err as Error;
      killWorker();

      if (lastError.message.startsWith('Failed to start card extractor')) throw lastError;

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RESTART_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError!;
}

/**
 * Gracefully shut down the card extractor worker.
 */
export function shutdownCardExtractor(): void {
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

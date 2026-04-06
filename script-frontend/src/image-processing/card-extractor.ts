import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type CardExtractResult = {
  player: string | null;
  team: string | null;
  card_number: string | null;
  error?: string;
};

export type SingleCardExtractResult = CardExtractResult & {
  side: 'front' | 'back' | null;
};

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RESTART_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min (first call loads model)
const WORKER_STARTUP_TIMEOUT_MS = 90_000; // 1.5 min to emit ready (PIL warm-up adds time)

// ── Persistent worker management ─────────────────────────────────────────────

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady = false;
let workerGeneration = 0; // increments on each spawn to detect stale close events
let readline: ReadlineInterface | null = null;
let spawnPromise: Promise<void> | null = null;

type QueuedRequest = {
  payload: object;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
};
const requestQueue: QueuedRequest[] = [];
let activeRequest: QueuedRequest | null = null;

let backendMode: 'ollama' | 'haiku' = 'ollama';

export function setCardExtractorBackend(mode: 'ollama' | 'haiku') {
  backendMode = mode;
}

function getEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONWARNINGS: 'ignore' };
  if (backendMode === 'ollama') {
    env.OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  } else {
    // Haiku mode: ensure OLLAMA_HOST is not set so Python falls through to Claude
    delete env.OLLAMA_HOST;
  }
  return env;
}

function spawnWorker(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'card_extractor.py');
    const venvPython = path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');

    killWorker();

    const gen = ++workerGeneration;

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
      // Stale worker — a newer one has been spawned; ignore output
      if (gen !== workerGeneration) return;

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
      if (gen !== workerGeneration) return; // stale worker
      workerReady = false;
      if (!gotReady) {
        clearTimeout(startupTimer);
        reject(new Error(`Failed to start card extractor worker: ${err.message}`));
      }
      rejectPending(new Error(`Card extractor worker error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (gen !== workerGeneration) return; // stale worker — don't clobber new worker's state
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
    // Reject any pending requests synchronously BEFORE clearing state,
    // so we don't rely on the async 'close' event (which may race with a new worker).
    rejectPending(new Error('Card extractor worker killed'));
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

// ── Native Claude Haiku extraction (no Python) ─────────────────────────────

const MAX_IMAGE_SIDE = 1500;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT =
  'You are a trading card expert. Extract information exactly as printed on the card.';

const USER_PROMPT =
  'Examine these trading card images (front and back) and extract:\n' +
  '1. player: The player\'s full name (null if not identifiable)\n' +
  '2. team: The team name (null if not identifiable)\n' +
  '3. card_number: The card number as printed on the BACK of the card (e.g. "BC-15", "123") (null if not visible). Do not use jersey numbers or stats from the front.\n\n' +
  'Be precise. Only return what is clearly visible on the card.';

const SINGLE_IMAGE_PROMPT =
  'Examine this single trading card image and extract:\n' +
  '1. player: The player\'s full name (null if not identifiable)\n' +
  '2. team: The team name (null if not identifiable)\n' +
  '3. card_number: The card number as printed (e.g. "BC-15", "123") (null if not visible)\n' +
  '4. side: "front" if this shows the player photo/action shot, "back" if this shows ' +
  'statistics, biography text, or copyright information\n\n' +
  'Be precise. Only return what is clearly visible on the card.';

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_card_info',
  description: 'Extract player name, team, and card number from trading card images',
  input_schema: {
    type: 'object' as const,
    properties: {
      player: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Full name of the player, or null if not identifiable',
      },
      team: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Team name, or null if not identifiable',
      },
      card_number: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Card number as printed (e.g. "BC-15", "123"), or null if not visible',
      },
    },
    required: ['player', 'team', 'card_number'],
  },
};

const EXTRACT_SINGLE_TOOL: Anthropic.Tool = {
  name: 'extract_single_card_info',
  description: 'Extract player name, team, card number, and front/back classification from a single trading card image',
  input_schema: {
    type: 'object' as const,
    properties: {
      player: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Full name of the player, or null if not identifiable',
      },
      team: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Team name, or null if not identifiable',
      },
      card_number: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Card number as printed (e.g. "BC-15", "123"), or null if not visible',
      },
      side: {
        type: 'string',
        enum: ['front', 'back'],
        description: 'Whether this is the front (player photo) or back (stats/bio) of the card',
      },
    },
    required: ['player', 'team', 'card_number', 'side'],
  },
};

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable not set');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

async function encodeImage(imagePath: string): Promise<{ base64: string; mediaType: 'image/jpeg' }> {
  const img = sharp(imagePath);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  let pipeline = img;
  if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) {
    const ratio = Math.min(MAX_IMAGE_SIDE / w, MAX_IMAGE_SIDE / h);
    pipeline = pipeline.resize(Math.round(w * ratio), Math.round(h * ratio));
  }

  const buf = await pipeline.jpeg({ quality: 85 }).toBuffer();
  return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
}

async function extractWithClaude(
  frontPath: string,
  backPath: string,
): Promise<CardExtractResult> {
  const client = getAnthropicClient();
  const [front, back] = await Promise.all([encodeImage(frontPath), encodeImage(backPath)]);

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_card_info' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: front.mediaType, data: front.base64 } },
        { type: 'image', source: { type: 'base64', media_type: back.mediaType, data: back.base64 } },
        { type: 'text', text: USER_PROMPT },
      ],
    }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'extract_card_info') {
      const inp = block.input as Record<string, unknown>;
      return {
        player: (inp.player as string) || null,
        team: (inp.team as string) || null,
        card_number: (inp.card_number as string) || null,
      };
    }
  }

  throw new Error('No tool_use block in Claude response');
}

async function extractSingleWithClaude(
  imagePath: string,
): Promise<SingleCardExtractResult> {
  const client = getAnthropicClient();
  const img = await encodeImage(imagePath);

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [EXTRACT_SINGLE_TOOL],
    tool_choice: { type: 'tool', name: 'extract_single_card_info' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
        { type: 'text', text: SINGLE_IMAGE_PROMPT },
      ],
    }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'extract_single_card_info') {
      const inp = block.input as Record<string, unknown>;
      const side = inp.side as string;
      const validSide = side === 'front' || side === 'back' ? side : null;
      return {
        player: (inp.player as string) || null,
        team: (inp.team as string) || null,
        // Card numbers are only on the back; ignore any value from fronts
        card_number: validSide === 'back' ? ((inp.card_number as string) || null) : null,
        side: validSide,
      };
    }
  }

  throw new Error('No tool_use block in Claude response');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract player, team, and card number from a card image pair.
 * In 'haiku' mode, calls Claude directly from TypeScript (no Python).
 * In 'ollama' mode, uses the persistent Python worker.
 */
export async function extractCardInfo(
  frontPath: string,
  backPath: string,
): Promise<CardExtractResult> {
  // Native TypeScript path for Claude Haiku — no Python subprocess needed
  if (backendMode === 'haiku') {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await extractWithClaude(frontPath, backPath);
      } catch (err) {
        lastError = err as Error;
        if (lastError.message.includes('API_KEY') || lastError.message.includes('not set')) throw lastError;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RESTART_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastError!;
  }

  // Python worker path for Ollama
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
 * Extract player, team, card number, and front/back side from a single card image.
 * In 'haiku' mode, calls Claude directly from TypeScript (no Python).
 * In 'ollama' mode, uses the persistent Python worker.
 */
export async function extractSingleCardInfo(
  imagePath: string,
): Promise<SingleCardExtractResult> {
  // Native TypeScript path for Claude Haiku
  if (backendMode === 'haiku') {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await extractSingleWithClaude(imagePath);
      } catch (err) {
        lastError = err as Error;
        if (lastError.message.includes('API_KEY') || lastError.message.includes('not set')) throw lastError;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RESTART_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastError!;
  }

  // Python worker path for Ollama
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ensureWorker();

      const responseLine = await Promise.race([
        sendRequest({ image: imagePath }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Card extractor request timed out')), REQUEST_TIMEOUT_MS),
        ),
      ]);

      const result = JSON.parse(responseLine) as SingleCardExtractResult;
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

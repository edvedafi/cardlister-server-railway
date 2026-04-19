import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createLogger } from '../utils/logger.js';

const debug = createLogger('remote-image-service');

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export type RemoteOrientation = 0 | 90 | 180 | 270;

export type RemoteProcessResult = {
  rotatedBytes: Buffer;
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  side: 'front' | 'back';
  textDetectionCount: number;
  orientation: RemoteOrientation;
};

export function isRemoteServiceEnabled(): boolean {
  return !!process.env.IMAGE_SERVICE_URL;
}

function getServiceUrl(): string {
  const url = process.env.IMAGE_SERVICE_URL;
  if (!url) throw new Error('IMAGE_SERVICE_URL is not set');
  return url.replace(/\/+$/, '');
}

function getInternalKey(): string {
  const key = process.env.IMAGE_SERVICE_KEY;
  if (!key) throw new Error('IMAGE_SERVICE_KEY is not set (set it in .env to match the preprocess service)');
  return key;
}

// Auth contract: watcher path uses a shared internal API key header. First-
// party clients (web/mobile) will use Google-issued ID tokens separately.
function authHeaders(): Record<string, string> {
  return { 'x-internal-key': getInternalKey() };
}

// ── Request helpers ─────────────────────────────────────────────────────────

async function buildFormData(imagePath: string): Promise<FormData> {
  const bytes = await fs.readFile(imagePath);
  const form = new FormData();
  // Wrap Node Buffer in a Blob so fetch streams it as multipart/form-data.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  form.append('image', blob, path.basename(imagePath));
  return form;
}

function isRetryable(status: number | null, err: unknown): boolean {
  if (status !== null) return status >= 500 && status < 600;
  return err instanceof TypeError || (err as { name?: string } | null)?.name === 'AbortError';
}

async function postWithRetry(endpoint: string, imagePath: string): Promise<Response> {
  const url = `${getServiceUrl()}${endpoint}`;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const form = await buildFormData(imagePath);
      const res = await fetch(url, {
        method: 'POST',
        body: form,
        headers: authHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) return res;
      if (!isRetryable(res.status, null) || attempt === MAX_ATTEMPTS) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 500)}`);
      }
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} ${endpoint} got ${res.status}, retrying`);
      lastErr = new Error(`${endpoint} ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (!isRetryable(null, err) || attempt === MAX_ATTEMPTS) throw err;
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} ${endpoint} threw: ${String(err)}, retrying`);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Response types ──────────────────────────────────────────────────────────
// Mirrors ProcessResponse in neonbinder_preprocess/app/main.py.

type ProcessResponseJson = {
  player: string | null;
  team: string | null;
  card_number: string | null;
  side: 'front' | 'back';
  rotation_degrees: RemoteOrientation;
  orient_confidence: number;
  text_count: number;
};

// ── Public API ──────────────────────────────────────────────────────────────

export async function remoteProcess(imagePath: string): Promise<RemoteProcessResult> {
  const res = await postWithRetry('/process', imagePath);
  const meta = (await res.json()) as ProcessResponseJson;

  // The server returns JSON only; rotation is applied client-side. Our server
  // reports `rotation_degrees` as the CCW rotation that makes text upright;
  // sharp's `.rotate(n)` is CW by n, so pass the negation. Zero short-circuits
  // to avoid a pointless re-encode of the already-upright source.
  const raw = await fs.readFile(imagePath);
  const rotatedBytes = meta.rotation_degrees === 0
    ? raw
    : await sharp(raw).rotate(-meta.rotation_degrees).toBuffer();

  return {
    rotatedBytes,
    player: meta.player,
    team: meta.team,
    cardNumber: meta.card_number,
    side: meta.side,
    textDetectionCount: meta.text_count,
    orientation: meta.rotation_degrees,
  };
}

export async function remoteCrop(imagePath: string, outputPath: string): Promise<boolean> {
  try {
    // TODO(slice-2): /crop-and-process is not yet implemented on the
    // preprocess service. postWithRetry will throw on the 404 (non-
    // retryable) and the catch below returns false, which triggers the
    // local-crop fallback in listSet.ts. Once slice 2 ships, replace this
    // stub with the actual response-body handling (likely JSON with base64
    // bytes + the same orient + classify metadata as /process).
    const res = await postWithRetry('/crop-and-process', imagePath);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outputPath, buf);
    return true;
  } catch (err) {
    debug(`remoteCrop failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

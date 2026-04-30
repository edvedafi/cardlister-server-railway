import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createLogger } from '../utils/logger.js';

const debug = createLogger('remote-image-service');

// Per-attempt request timeout. Override with IMAGE_SERVICE_TIMEOUT_MS if the
// upstream is temporarily slower than usual; the watcher's INTAKE_CONCURRENCY
// (default 10) is the other knob — drop it further if the log shows clustered
// timeouts even with backoff in place.
const REQUEST_TIMEOUT_MS = Number(process.env.IMAGE_SERVICE_TIMEOUT_MS) || 120_000;
const MAX_ATTEMPTS = 3;

// Bound the upload when sending the original. The server's crop cascade
// (SAM/Haiku/PIL) doesn't need the full sensor resolution; bounding here
// keeps a 22 MB raw scan from hitting the upstream's body-size limit (413).
// Threshold > target so already-small images aren't re-encoded.
const UPLOAD_MAX_SIDE = Number(process.env.IMAGE_SERVICE_MAX_UPLOAD_SIDE) || 3000;
const UPLOAD_DOWNSCALE_THRESHOLD =
  Number(process.env.IMAGE_SERVICE_DOWNSCALE_THRESHOLD) || 3500;
const UPLOAD_QUALITY = Number(process.env.IMAGE_SERVICE_DOWNSCALE_QUALITY) || 85;

// ── Crop-only mode config ───────────────────────────────────────────────────
// Kill switch. Default OFF — human flips this for staged rollout after
// measuring rejection rate on a trusted batch.
const USE_CROP_ONLY = process.env.USE_CROP_ONLY === '1';
// Circuit-breaker tuning. If crop-only rejection rate exceeds the threshold
// over a rolling window (after warmup), crop-only is disabled for the rest of
// the process lifetime — prevents a cropper regression from compounding upload
// concurrency with 22 MB retries (the original production incident).
const CROP_ONLY_REJECT_THRESHOLD = 0.25;
const CROP_ONLY_WINDOW_SIZE = 100;
const CROP_ONLY_WARMUP_SAMPLES = 20;
// Global concurrency cap for retry-with-original requests, kept separate from
// the watcher's intakeQueue (default 10). At max 4 simultaneous retries, a
// 100% rejection storm can't fan out to 10 concurrent 22 MB uploads.
const RETRY_WITH_ORIGINAL_CONCURRENCY = 4;

export type RemoteOrientation = 0 | 90 | 180 | 270;

export type RemoteCroppedSource =
  | 'precropped'
  | 'pil_trim_dark'
  | 'pil_trim_light'
  | 'sam'
  | 'haiku_bbox'
  | 'passthrough';

export type RemoteCropStrategy =
  | 'pil_trim_dark'
  | 'pil_trim_light'
  | 'sam'
  | 'haiku_bbox';

export type RemoteCropAlternative = {
  strategy: RemoteCropStrategy;
  index: number;
  bytes: Buffer | null;
  error: string | null;
};

export type RemoteProcessResult = {
  rotatedBytes: Buffer;
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  side: 'front' | 'back';
  textDetectionCount: number;
  orientation: RemoteOrientation;
  croppedSource: RemoteCroppedSource;
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

// ── Crop-only circuit breaker ───────────────────────────────────────────────

const cropOnlyOutcomes: boolean[] = [];
let cropOnlyDisabled = false;

function recordCropOnlyOutcome(rejected: boolean): void {
  cropOnlyOutcomes.push(rejected);
  if (cropOnlyOutcomes.length > CROP_ONLY_WINDOW_SIZE) cropOnlyOutcomes.shift();
  if (cropOnlyDisabled || cropOnlyOutcomes.length < CROP_ONLY_WARMUP_SAMPLES) return;
  const rejects = cropOnlyOutcomes.filter(Boolean).length;
  const rate = rejects / cropOnlyOutcomes.length;
  if (rate > CROP_ONLY_REJECT_THRESHOLD) {
    cropOnlyDisabled = true;
    debug(
      `CIRCUIT BREAKER TRIPPED: crop-only rejection rate ${(rate * 100).toFixed(1)}% ` +
      `over ${cropOnlyOutcomes.length} samples — disabling crop-only for rest of run`,
    );
  }
}

// ── Retry-with-original semaphore ───────────────────────────────────────────

let retryInFlight = 0;
const retryWaiters: Array<() => void> = [];

async function acquireRetrySlot(): Promise<() => void> {
  if (retryInFlight < RETRY_WITH_ORIGINAL_CONCURRENCY) {
    retryInFlight++;
  } else {
    await new Promise<void>((resolve) => retryWaiters.push(resolve));
    retryInFlight++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retryInFlight--;
    const next = retryWaiters.shift();
    if (next) next();
  };
}

// ── Request helpers ─────────────────────────────────────────────────────────

function isRetryable(status: number | null, err: unknown): boolean {
  if (status !== null) return status >= 500 && status < 600;
  return err instanceof TypeError || (err as { name?: string } | null)?.name === 'AbortError';
}

// Exponential backoff with jitter between retries. Spreads thundering-herd
// retries that would otherwise re-overload an already-saturated service.
async function backoff(attempt: number): Promise<void> {
  const base = 1000 * Math.pow(3, attempt - 1); // 1s, 3s, ...
  const jitter = Math.random() * base * 0.5;
  await new Promise((r) => setTimeout(r, base + jitter));
}

type LogExtras = { reason?: string; source?: string; downscaled?: boolean };
type RequestMode = 'crop_only' | 'crop_only_retry' | 'image_only';

function logRequest(mode: RequestMode, status: number, durationMs: number, extras: LogExtras = {}): void {
  const parts = [`/process mode=${mode}`, `status=${status}`, `duration_ms=${durationMs}`];
  if (extras.reason) parts.push(`reason=${JSON.stringify(extras.reason)}`);
  if (extras.source) parts.push(`source=${extras.source}`);
  if (extras.downscaled) parts.push('downscaled=true');
  debug(parts.join(' '));
}

// Read the original; if either dimension exceeds the threshold, downscale to
// UPLOAD_MAX_SIDE on the long edge. Pass-through for already-small images
// (no re-encode). Cost on a 5312×2885 → 3000-side resize via sharp is < 200 ms.
async function readOriginalForUpload(
  originalPath: string,
): Promise<{ bytes: Buffer; downscaled: boolean }> {
  const raw = await fs.readFile(originalPath);
  const meta = await sharp(raw).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (Math.max(w, h) <= UPLOAD_DOWNSCALE_THRESHOLD) {
    return { bytes: raw, downscaled: false };
  }
  const startMs = Date.now();
  const resized = await sharp(raw)
    .resize(UPLOAD_MAX_SIDE, UPLOAD_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: UPLOAD_QUALITY })
    .toBuffer();
  debug(
    `downscaled ${path.basename(originalPath)} ${w}x${h} → max ${UPLOAD_MAX_SIDE}px ` +
    `(${(raw.length / 1024 / 1024).toFixed(1)}MB → ${(resized.length / 1024 / 1024).toFixed(1)}MB, ` +
    `${Date.now() - startMs}ms)`,
  );
  return { bytes: resized, downscaled: true };
}

// Internal signal used by the crop-only path to tell the dispatcher "bail out
// and retry with the original attached". Never leaks to callers.
class RetryWithOriginalSignal extends Error {
  constructor(public readonly cause: string) {
    super(`retry-with-original: ${cause}`);
    this.name = 'RetryWithOriginalSignal';
  }
}

// Fatal crop-only outcomes — server 422 without retry_with_original, or 400
// MISSING_IMAGE. Bubble to the caller untouched; do not retry.
class FatalCropOnlyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FatalCropOnlyError';
  }
}

// ── Crop-only single-attempt request ────────────────────────────────────────

async function postProcessCropOnly(precroppedPath: string): Promise<Response> {
  const startMs = Date.now();
  const precroppedBytes = await fs.readFile(precroppedPath);
  const precroppedName = path.basename(precroppedPath);

  const form = new FormData();
  form.append(
    'precropped',
    new Blob([new Uint8Array(precroppedBytes)], { type: 'image/jpeg' }),
    precroppedName,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${getServiceUrl()}/process`, {
      method: 'POST',
      body: form,
      headers: authHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const durationMs = Date.now() - startMs;

    if (res.ok) {
      recordCropOnlyOutcome(false);
      logRequest('crop_only', res.status, durationMs, { source: 'precropped' });
      return res;
    }

    // Need to peek the body to classify 422/400 — FormData body was already
    // consumed by fetch, so we're free to read the response body once here.
    const bodyText = await res.text().catch(() => '');
    let parsed: { error_code?: string; reason?: string; retry_with_original?: boolean } | null = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }

    if (res.status === 422 && parsed?.error_code === 'CROP_VALIDATION_FAILED') {
      const reason = String(parsed.reason ?? 'unknown');
      recordCropOnlyOutcome(true);
      logRequest('crop_only', 422, durationMs, { reason });
      if (parsed.retry_with_original === true) {
        throw new RetryWithOriginalSignal(reason);
      }
      throw new FatalCropOnlyError(`/process crop-only 422 (no retry): ${reason}`);
    }

    if (res.status === 400 && parsed?.error_code === 'MISSING_IMAGE') {
      logRequest('crop_only', 400, durationMs, { reason: 'MISSING_IMAGE' });
      debug(
        'CLIENT BUG: /process returned 400 MISSING_IMAGE in crop-only mode — ' +
        'neither field accepted by server. Not retrying.',
      );
      throw new FatalCropOnlyError(`/process 400 MISSING_IMAGE (client bug): ${bodyText.slice(0, 200)}`);
    }

    // 5xx or other unexpected non-2xx — don't count as a rejection; fall
    // through to retry-with-original so a transient backend hiccup doesn't
    // burn the crop-only mode's reputation in the breaker window.
    logRequest('crop_only', res.status, durationMs);
    throw new RetryWithOriginalSignal(`upstream ${res.status}`);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof RetryWithOriginalSignal) throw err;
    if (err instanceof FatalCropOnlyError) throw err;
    // Network/timeout — retry with original. Not a rejection.
    const durationMs = Date.now() - startMs;
    logRequest('crop_only', 0, durationMs, { reason: `network: ${String(err)}` });
    throw new RetryWithOriginalSignal(`network: ${String(err)}`);
  }
}

// ── With-original request (classic path, existing 5xx retry loop) ───────────

async function postProcessWithOriginal(
  originalPath: string,
  precroppedPath: string | undefined,
  mode: 'image_only' | 'crop_only_retry',
): Promise<Response> {
  const startMs = Date.now();
  const { bytes: originalBytes, downscaled } = await readOriginalForUpload(originalPath);
  const originalName = path.basename(originalPath);
  let precroppedBytes: Buffer | undefined;
  let precroppedName: string | undefined;
  if (precroppedPath) {
    precroppedBytes = await fs.readFile(precroppedPath);
    precroppedName = path.basename(precroppedPath);
  }

  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let shouldRetry = false;
    try {
      // FormData/Blob bodies are consumable once per fetch; re-create each
      // attempt. Underlying Buffers are reused, so no per-attempt disk I/O.
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(originalBytes)], { type: 'image/jpeg' }), originalName);
      if (precroppedBytes && precroppedName) {
        form.append(
          'precropped',
          new Blob([new Uint8Array(precroppedBytes)], { type: 'image/jpeg' }),
          precroppedName,
        );
      }

      const res = await fetch(`${getServiceUrl()}/process`, {
        method: 'POST',
        body: form,
        headers: authHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        logRequest(mode, res.status, Date.now() - startMs, { downscaled });
        return res;
      }

      // A 422 on the with-original path means the server rejected even after
      // it had the original available — that's a hard failure, never loop.
      // This defends against contract drift; under today's server it can't
      // happen because the cascade on this path doesn't validation-fail.
      if (res.status === 422) {
        const text = await res.text().catch(() => '<no body>');
        logRequest(mode, 422, Date.now() - startMs, { reason: '422 with original', downscaled });
        throw new Error(`/process 422 with original attached: ${text.slice(0, 500)}`);
      }

      if (!isRetryable(res.status, null) || attempt === MAX_ATTEMPTS) {
        const text = await res.text().catch(() => '<no body>');
        logRequest(mode, res.status, Date.now() - startMs, { downscaled });
        throw new Error(`/process ${res.status}: ${text.slice(0, 500)}`);
      }
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} /process got ${res.status}, retrying`);
      lastErr = new Error(`/process ${res.status}`);
      shouldRetry = true;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (!isRetryable(null, err) || attempt === MAX_ATTEMPTS) {
        logRequest(mode, 0, Date.now() - startMs, { reason: `network: ${String(err)}`, downscaled });
        throw err;
      }
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} /process threw: ${String(err)}, retrying`);
      shouldRetry = true;
    }

    if (shouldRetry && attempt < MAX_ATTEMPTS) await backoff(attempt);
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

async function postProcess(originalPath: string, precroppedPath?: string): Promise<Response> {
  const cropOnlyViable = USE_CROP_ONLY && !!precroppedPath && !cropOnlyDisabled;

  if (cropOnlyViable) {
    try {
      return await postProcessCropOnly(precroppedPath!);
    } catch (err) {
      if (!(err instanceof RetryWithOriginalSignal)) throw err;
      // Fall through to retry-with-original, gated by the separate retry pool
      // so crop-only rejections can't compound upload concurrency.
    }
    const release = await acquireRetrySlot();
    try {
      return await postProcessWithOriginal(originalPath, precroppedPath, 'crop_only_retry');
    } finally {
      release();
    }
  }

  return postProcessWithOriginal(originalPath, precroppedPath, 'image_only');
}

// ── Response types ──────────────────────────────────────────────────────────
// Mirrors ProcessResponse in neonbinder_preprocess/app/main.py.

type ProcessResponseJson = {
  players: string[];
  player: string | null;
  team: string | null;
  card_number: string | null;
  side: 'front' | 'back';
  rotation_degrees: RemoteOrientation;
  orient_confidence: number;
  text_count: number;
  cropped_source: RemoteCroppedSource;
  cropped_image_b64: string | null;
};

// ── Public API ──────────────────────────────────────────────────────────────

export async function remoteProcess(
  originalPath: string,
  precroppedPath?: string,
): Promise<RemoteProcessResult> {
  const res = await postProcess(originalPath, precroppedPath);
  const meta = (await res.json()) as ProcessResponseJson;

  // Pick the bytes for the final cropped image based on which cascade stage won.
  // The server omits cropped_image_b64 when it used bytes the client already has.
  let croppedBytes: Buffer;
  if (meta.cropped_source === 'precropped' && precroppedPath) {
    croppedBytes = await fs.readFile(precroppedPath);
  } else if (meta.cropped_source === 'passthrough') {
    croppedBytes = await fs.readFile(originalPath);
  } else if (meta.cropped_image_b64) {
    croppedBytes = Buffer.from(meta.cropped_image_b64, 'base64');
  } else {
    throw new Error(
      `/process returned cropped_source=${meta.cropped_source} with no cropped_image_b64 and no local fallback available`,
    );
  }

  // Server reports rotation_degrees as the CCW rotation that makes text upright;
  // sharp's `.rotate(n)` is CW by n, so pass the negation. Zero short-circuits
  // to avoid a pointless re-encode.
  const rotatedBytes = meta.rotation_degrees === 0
    ? croppedBytes
    : await sharp(croppedBytes).rotate(-meta.rotation_degrees).toBuffer();

  debug(
    `/process source=${meta.cropped_source} rot=${meta.rotation_degrees}° ` +
    `players=${JSON.stringify(meta.players)} team=${meta.team} card#=${meta.card_number}`,
  );

  return {
    rotatedBytes,
    player: meta.player,
    team: meta.team,
    cardNumber: meta.card_number,
    side: meta.side,
    textDetectionCount: meta.text_count,
    orientation: meta.rotation_degrees,
    croppedSource: meta.cropped_source,
  };
}

// ── /crop endpoint ──────────────────────────────────────────────────────────
// Walks every crop strategy on the original (no orient/classify) so a caller
// (e.g. the review menu's re-crop key) can survey alternatives when the
// `/process` cascade's automatic pick was wrong.

type CropResponseEntry = {
  strategy: RemoteCropStrategy;
  index: number;
  image_b64: string | null;
  error: string | null;
};

type CropResponseJson = { crops: CropResponseEntry[] };

export async function cropAlternativesRemote(
  originalPath: string,
): Promise<RemoteCropAlternative[]> {
  const startMs = Date.now();
  const { bytes, downscaled } = await readOriginalForUpload(originalPath);
  const originalName = path.basename(originalPath);

  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let shouldRetry = false;
    try {
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), originalName);

      const res = await fetch(`${getServiceUrl()}/crop`, {
        method: 'POST',
        body: form,
        headers: authHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const json = (await res.json()) as CropResponseJson;
        debug(
          `/crop status=${res.status} duration_ms=${Date.now() - startMs}` +
          (downscaled ? ' downscaled=true' : '') +
          ` strategies=${json.crops.map((c) => `${c.strategy}:${c.image_b64 ? 'ok' : c.error ?? 'null'}`).join(',')}`,
        );
        return json.crops.map((c) => ({
          strategy: c.strategy,
          index: c.index,
          bytes: c.image_b64 ? Buffer.from(c.image_b64, 'base64') : null,
          error: c.error,
        }));
      }

      if (!isRetryable(res.status, null) || attempt === MAX_ATTEMPTS) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`/crop ${res.status}: ${text.slice(0, 500)}`);
      }
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} /crop got ${res.status}, retrying`);
      lastErr = new Error(`/crop ${res.status}`);
      shouldRetry = true;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (!isRetryable(null, err) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      debug(`attempt ${attempt}/${MAX_ATTEMPTS} /crop threw: ${String(err)}, retrying`);
      shouldRetry = true;
    }

    if (shouldRetry && attempt < MAX_ATTEMPTS) await backoff(attempt);
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

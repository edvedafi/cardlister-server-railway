/**
 * NeonBinder streaming-intake client (NEO-170).
 *
 * Talks to the NeonBinder Convex backend's placeholder streaming pipeline:
 * one stream job per listing session, one signed-URL upload per scan, and
 * reactive subscriptions for per-image progress and server-side front/back
 * pairing. The server does ALL cropping, identity extraction, and pairing —
 * this client only moves bytes and reacts to state.
 *
 * Enabled when NEONBINDER_CONVEX_URL is set (mirrors the IMAGE_SERVICE_URL
 * gating pattern in remote-image-service.ts). See NEONBINDER_STREAMING.md for
 * the full environment contract and runbook.
 *
 * Auth (NEO-172, machine keys): the client holds ONE per-client credential —
 * a NeonBinder API key (`ak_…` secret) created by the user in the web app's
 * Settings → API Keys page (Clerk-stored, user-scoped, revocable there at any
 * time). Tokens come from the backend's `POST /machine/token` exchange: the
 * key goes in, a short-lived session JWT for the key's OWNER comes out, and
 * ConvexClient refreshes through it automatically. Identical against preview,
 * dev, and production — no environment-specific auth machinery, and no
 * credential in this process can act as any user other than the key's owner.
 * The key and the minted tokens are never logged, even truncated.
 */
import fs from 'fs';
import { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { createLogger } from './logger.js';

const debug = createLogger('neonbinder');

// ── Feature flag ───────────────────────────────────────────────────────────

export const isStreamingEnabled = (): boolean => !!process.env.NEONBINDER_CONVEX_URL;

// ── Server function references ─────────────────────────────────────────────
// This repo has no Convex codegen; references are built from function paths.
// The authoritative definitions live in the neonbinder monorepo:
//   apps/web/convex/placeholderStream.ts / placeholderPipeline.ts /
//   adapters/placeholderUploads.ts / machineAuth.ts

const fnStartStream = makeFunctionReference<'mutation'>('placeholderStream:startPlaceholderStream');
const fnConfirmUpload = makeFunctionReference<'mutation'>('placeholderStream:confirmPlaceholderImageUpload');
const fnCloseStream = makeFunctionReference<'mutation'>('placeholderStream:closePlaceholderStream');
const fnCancelBatch = makeFunctionReference<'mutation'>('placeholderPipeline:cancelPlaceholderBatch');
const fnCreateImageUploadUrl = makeFunctionReference<'action'>(
  'adapters/placeholderUploads:createPlaceholderImageUploadUrl',
);
const fnCreateImageDownloadUrl = makeFunctionReference<'action'>(
  'adapters/placeholderUploads:createPlaceholderImageDownloadUrl',
);
// Public, auth-required, fire-and-forget warm-up. Kicks the scale-to-zero
// preprocess service's (multi-minute) model load early so the cold start
// overlaps set selection and app setup instead of stalling the first upload.
// The authoritative definition lives in the monorepo alongside the internal
// `placeholderBatch:warmupPreprocess` fan-out; the exact `module:name` here is
// a coordination point with the NeonBinder side — keep them in lock-step.
const fnWarmPreprocess = makeFunctionReference<'action'>('placeholderPipeline:warmPreprocess');
const qGetJob = makeFunctionReference<'query'>('placeholderPipeline:getPlaceholderJob');
const qListImages = makeFunctionReference<'query'>('placeholderPipeline:listPlaceholderImages');
const qListPairs = makeFunctionReference<'query'>('placeholderPipeline:listPlaceholderPairs');
// Manual-override mutations (NEO-170): identity correction + force-pair/unpair.
// Reached the same makeFunctionReference way as everything else; the exact
// `module:name` is a coordination point with the NeonBinder backend — if the
// backend hasn't renamed to these yet, the call surfaces a "could not find
// function" error which the wrappers below turn into a clear, non-fatal warning
// (no fallback is invented).
const fnUpdateImageIdentity = makeFunctionReference<'mutation'>(
  'placeholderPairing:updatePlaceholderImageIdentity',
);
const fnManualPair = makeFunctionReference<'mutation'>('placeholderPairing:manuallyPairPlaceholderImages');
const fnUnpair = makeFunctionReference<'mutation'>('placeholderPairing:unpairPlaceholderImages');

// ── Missing-backend-function signalling ─────────────────────────────────────
// The three override mutations are being renamed on the NeonBinder side in
// parallel with this client. Until that lands, a call raises Convex's "Could
// not find public function" error; we surface it as this typed error so the
// watcher can show a clear message and continue, instead of inventing a
// fallback or crashing the scan session.

export class MissingBackendFunctionError extends Error {
  readonly missing = true;
  constructor(public readonly fn: string) {
    super(`NeonBinder backend function "${fn}" is not available yet (not deployed/renamed).`);
    this.name = 'MissingBackendFunctionError';
  }
}

const isMissingFunctionError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /could not find\b.*\bfunction/is.test(msg);
};

// ── Wire shapes (mirrors of the server's `returns:` validators) ────────────

export interface StreamJobSnapshot {
  jobId: string;
  status:
    | 'pending'
    | 'uploaded'
    | 'collecting'
    | 'extracting'
    | 'processing'
    | 'pairing'
    | 'succeeded'
    | 'failed';
  mode?: 'zip' | 'stream';
  totalImages: number;
  processedImages: number;
  failedImages: number;
  rejectedEntries: number;
  pairCount: number;
  lastActivityAt?: number;
  errorCode?: string;
  errorDetail?: string;
}

export interface StreamImageRow {
  entryIndex: number;
  originalName: string;
  status: 'awaiting_upload' | 'queued' | 'processing' | 'done' | 'failed';
  players?: string[];
  team?: string;
  cardNumber?: string;
  side?: string;
  textCount?: number;
  pairStatus?: 'paired' | 'unmatched';
  errorCode?: string;
  errorDetail?: string;
}

export interface StreamPairRow {
  frontIndex: number;
  backIndex: number;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: 'exact' | 'fuzzy' | 'side-only';
  mechanism: 'adjacency' | 'pool';
  score: number;
}

interface UploadAllocation {
  uploadUrl: string;
  fields: Record<string, string>;
  entryIndex: number;
  expiresAt: number;
  maxUploadBytes: number;
}

// ── Environment ────────────────────────────────────────────────────────────

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const requireEnv = (name: string, why: string): string => {
  const v = env(name);
  if (!v) {
    throw new Error(
      `${name} is not set — ${why}. See NEONBINDER_STREAMING.md for the full environment contract.`,
    );
  }
  return v;
};

/**
 * Convex serves functions on `.convex.cloud` and HTTP actions on
 * `.convex.site`. The machine-token exchange is an HTTP action, so its origin
 * is derived from the deployment URL; NEONBINDER_CONVEX_SITE_URL overrides
 * for setups where the two don't follow the standard pairing (self-hosted,
 * local backends).
 */
const deriveSiteUrl = (convexUrl: string): string => {
  const override = env('NEONBINDER_CONVEX_SITE_URL');
  if (override) {
    // The machine key travels in the POST body to this origin — https only,
    // with a loopback exception for a locally-running backend. An http URL
    // to anything else would send the credential in cleartext.
    const isLoopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(override);
    if (!/^https:\/\//.test(override) && !isLoopback) {
      throw new Error(
        'NEONBINDER_CONVEX_SITE_URL must be https:// (or a http://localhost loopback for local dev).',
      );
    }
    return override.replace(/\/$/, '');
  }
  const match = convexUrl.match(/^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/);
  if (!match) {
    throw new Error(
      `Cannot derive the HTTP-actions origin from NEONBINDER_CONVEX_URL (${convexUrl}) — set NEONBINDER_CONVEX_SITE_URL explicitly.`,
    );
  }
  return `https://${match[1]}.convex.site`;
};

// ── Machine-token auth ─────────────────────────────────────────────────────

class MachineTokenSource {
  private siteUrl: string;
  private key: string;
  private sessionId: string | null = null;

  constructor(siteUrl: string, key: string) {
    this.siteUrl = siteUrl;
    this.key = key;
  }

  /**
   * Exchange the machine key for a short-lived session JWT. Called by
   * ConvexClient's auth refresh loop, so it must stay cheap and quiet.
   * Status-only diagnostics on every failure path — the key and the token
   * never reach the (disk-persistent) debug log.
   */
  async fetchToken(): Promise<string | null> {
    try {
      const res = await fetch(`${this.siteUrl}/machine/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: this.key,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        }),
      });
      if (!res.ok) {
        debug(`machine token exchange failed (HTTP ${res.status})`);
        return null;
      }
      const body = (await res.json()) as { token?: string; sessionId?: string };
      if (body.sessionId) this.sessionId = body.sessionId;
      return body.token ?? null;
    } catch (err) {
      debug(
        `machine token exchange failed (network: ${err instanceof Error ? err.constructor.name : 'unknown'})`,
      );
      return null;
    }
  }

  /**
   * One loud pre-flight so a bad key fails at startup, not mid-scan.
   *
   * A bad key (401) is fatal immediately — retrying it is pointless and only
   * adds Clerk load. But a TRANSIENT upstream blip — a 502 ("auth upstream
   * unavailable"), a momentary 503, a 429 (Clerk's Frontend API briefly
   * rate-limited), or a network/fetch rejection — must NOT end `yarn start`:
   * those are retried with exponential-ish backoff (5 attempts / 4 retries,
   * ~1.5s→8s capped, ~18.5s total worst case) before giving up. Diagnostics
   * stay status-only; the key and any minted token never reach the log.
   */
  async probe(): Promise<void> {
    const TRANSIENT_STATUS = new Set([429, 502, 503]);
    const MAX_ATTEMPTS = 5; // → up to MAX_ATTEMPTS-1 retries
    const BASE_DELAY_MS = 1500;
    const MAX_DELAY_MS = 8000;
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const backoffMs = (attempt: number): number =>
      Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.siteUrl}/machine/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: this.key }),
        });
      } catch (err) {
        // Network/fetch rejection (DNS blip, reset connection) — transient.
        const name = err instanceof Error ? err.constructor.name : 'network error';
        if (attempt < MAX_ATTEMPTS) {
          const delay = backoffMs(attempt);
          debug(
            `machine-token pre-flight network error (${name}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        throw new Error(
          `Cannot reach the NeonBinder machine-token endpoint at ${this.siteUrl} (${name}) after ${MAX_ATTEMPTS - 1} retries — wait a moment and run yarn start again.`,
        );
      }

      // Invalid/revoked key — fatal immediately, never retried.
      if (res.status === 401) {
        throw new Error(
          'NeonBinder rejected the machine key (401). Create a key in the web app under Settings → API Keys and set NEONBINDER_MACHINE_KEY — and check it was not revoked.',
        );
      }

      // Transient upstream failure — back off and retry.
      if (TRANSIENT_STATUS.has(res.status)) {
        if (attempt < MAX_ATTEMPTS) {
          const delay = backoffMs(attempt);
          debug(
            `machine-token pre-flight transient failure (HTTP ${res.status}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        // Retries exhausted. A persistent 503 really is an unconfigured
        // deployment (missing CLERK_SECRET_KEY), not a momentary blip.
        if (res.status === 503) {
          throw new Error(
            'The NeonBinder machine-token endpoint is not configured on this deployment (503) — CLERK_SECRET_KEY is missing server-side.',
          );
        }
        throw new Error(
          `NeonBinder auth is temporarily unavailable (HTTP ${res.status}) after ${MAX_ATTEMPTS - 1} retries — the identity provider may be rate-limited; wait a moment and run yarn start again.`,
        );
      }

      // Any other non-2xx — not transient, fail immediately.
      if (!res.ok) {
        throw new Error(`Machine-token exchange failed (HTTP ${res.status}).`);
      }

      const body = (await res.json()) as { sessionId?: string };
      if (body.sessionId) this.sessionId = body.sessionId;
      debug(
        attempt > 1
          ? `machine key verified against the deployment (after ${attempt - 1} retr${attempt === 2 ? 'y' : 'ies'})`
          : 'machine key verified against the deployment',
      );
      return;
    }
  }
}

// ── The client ─────────────────────────────────────────────────────────────

export class NeonBinderStreamClient {
  private convex: ConvexClient;
  jobId: string | null = null;
  private closed = false;

  private constructor(convex: ConvexClient) {
    this.convex = convex;
  }

  /** Connect, authenticate, and verify the key round-trip. */
  static async connect(): Promise<NeonBinderStreamClient> {
    const convexUrl = requireEnv('NEONBINDER_CONVEX_URL', 'the Convex deployment to stream into');
    const machineKey = requireEnv(
      'NEONBINDER_MACHINE_KEY',
      'your NeonBinder API key — create one in the web app under Settings → API Keys',
    );

    const source = new MachineTokenSource(deriveSiteUrl(convexUrl), machineKey);
    await source.probe();

    const webSocketConstructor =
      typeof WebSocket !== 'undefined'
        ? undefined
        : ((await import('ws')).default as unknown as typeof WebSocket);
    const convex = new ConvexClient(convexUrl, {
      ...(webSocketConstructor ? { webSocketConstructor } : {}),
    });
    convex.setAuth(() => source.fetchToken());

    debug(`Connected to ${convexUrl}`);
    return new NeonBinderStreamClient(convex);
  }

  async startStream(): Promise<string> {
    const result = (await this.convex.mutation(fnStartStream, {})) as {
      started: boolean;
      jobId?: string;
      reason?: string;
    };
    if (!result.started || !result.jobId) {
      throw new Error(`NeonBinder refused to open a scan session: ${result.reason ?? 'unknown reason'}`);
    }
    this.jobId = result.jobId;
    debug(`Stream job opened: ${result.jobId}`);
    return result.jobId;
  }

  /**
   * Fire-and-forget preprocess warm-up. Triggers the server's scale-to-zero
   * model load NOW, so its multi-minute cold start overlaps the user's set
   * selection and app setup rather than stalling the first upload. Needs no
   * open stream job — safe to call the instant connect() returns and before
   * startStream(). Best-effort: dispatches the action and returns immediately,
   * awaiting nothing and never throwing. Failures are logged status-only (the
   * key and minted token are never touched here).
   */
  warm(): void {
    try {
      void this.convex
        .action(fnWarmPreprocess, {})
        .then(() => debug('preprocess warm-up requested'))
        .catch((err) =>
          debug(
            `preprocess warm-up request failed (non-fatal: ${err instanceof Error ? err.constructor.name : 'unknown'})`,
          ),
        );
    } catch (err) {
      // Guard the synchronous dispatch path too (e.g. a closed socket); a
      // warm-up must never be able to disturb the caller's flow.
      debug(`preprocess warm-up could not be dispatched (non-fatal: ${err instanceof Error ? err.constructor.name : 'unknown'})`);
    }
  }

  private requireJob(): string {
    if (!this.jobId) throw new Error('startStream() has not been called');
    return this.jobId;
  }

  async allocateUpload(originalName: string, contentType = 'image/jpeg'): Promise<UploadAllocation> {
    return (await this.convex.action(fnCreateImageUploadUrl, {
      jobId: this.requireJob(),
      contentType,
      originalName,
    })) as UploadAllocation;
  }

  /**
   * POST the file to GCS with the signed policy. Policy fields go first,
   * the file field last — GCS ignores anything after `file`.
   */
  async uploadFile(alloc: UploadAllocation, localPath: string, contentType = 'image/jpeg'): Promise<void> {
    const bytes = await fs.promises.readFile(localPath);
    if (bytes.byteLength > alloc.maxUploadBytes) {
      throw new Error(
        `${localPath} is ${bytes.byteLength} bytes — over the ${alloc.maxUploadBytes}-byte upload cap`,
      );
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(alloc.fields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: contentType }), alloc.fields['key'] ?? 'upload');
    const res = await fetch(alloc.uploadUrl, { method: 'POST', body: form });
    if (!res.ok) {
      // Status only, never the response body: GCS's XML error detail for
      // policy mismatches can quote the signed policy document itself, and
      // errors here end up in the persistent debug log. 412 = something
      // already exists at this key; each allocation is a fresh index, so
      // that means a replayed/duplicate POST.
      const hint = res.status === 412 ? ' (object already exists — duplicate POST?)' : '';
      throw new Error(`GCS upload failed (HTTP ${res.status})${hint}`);
    }
  }

  async confirmUpload(entryIndex: number): Promise<{ alreadyConfirmed: boolean; totalImages: number }> {
    const result = (await this.convex.mutation(fnConfirmUpload, {
      jobId: this.requireJob(),
      entryIndex,
    })) as { confirmed: boolean; alreadyConfirmed: boolean; totalImages: number };
    return result;
  }

  /**
   * ABORT the session: unlike close (which drains — everything uploaded still
   * processes and bills), cancel stops queued and in-flight processing now.
   * The job lands terminal ("canceled" failure); nothing further is paired.
   * Returns how many pending work items were killed. Never throws.
   */
  async cancelBatch(): Promise<number> {
    if (this.closed || !this.jobId) return 0;
    this.closed = true;
    try {
      const result = (await this.convex.mutation(fnCancelBatch, { jobId: this.jobId })) as {
        canceled: boolean;
        canceledCount: number;
        reason?: string;
      };
      debug(
        result.canceled
          ? `Batch canceled — ${result.canceledCount} pending item(s) stopped`
          : `Cancel was a no-op: ${result.reason ?? ''}`,
      );
      return result.canceledCount;
    } catch (err) {
      debug(`cancelBatch failed (server idle-sweep will finish the job): ${String(err)}`);
      return 0;
    }
  }

  /** Close the scan session. Safe to call twice; never throws. */
  async closeStream(): Promise<void> {
    if (this.closed || !this.jobId) return;
    this.closed = true;
    try {
      const result = (await this.convex.mutation(fnCloseStream, { jobId: this.jobId })) as {
        closed: boolean;
        status?: string;
        reason?: string;
      };
      debug(
        result.closed
          ? `Stream closed → ${result.status ?? 'processing'}`
          : `Stream close was a no-op: ${result.reason ?? ''}`,
      );
    } catch (err) {
      // The 30-minute idle sweep on the server is the backstop.
      debug(`closeStream failed (server idle-sweep will finish the job): ${String(err)}`);
    }
  }

  onJob(cb: (job: StreamJobSnapshot | null) => void): () => void {
    return this.convex.onUpdate(qGetJob, { jobId: this.requireJob() }, (job) =>
      cb(job as StreamJobSnapshot | null),
    );
  }

  onImages(cb: (rows: StreamImageRow[]) => void): () => void {
    return this.convex.onUpdate(qListImages, { jobId: this.requireJob() }, (rows) =>
      cb(rows as StreamImageRow[]),
    );
  }

  onPairs(cb: (rows: StreamPairRow[]) => void): () => void {
    return this.convex.onUpdate(qListPairs, { jobId: this.requireJob() }, (rows) =>
      cb(rows as StreamPairRow[]),
    );
  }

  /** Signed GET URL for the server-side CROPPED output of a processed image. */
  async getDownloadUrl(entryIndex: number): Promise<string> {
    const result = (await this.convex.action(fnCreateImageDownloadUrl, {
      jobId: this.requireJob(),
      entryIndex,
    })) as { url: string; expiresAt: number };
    return result.url;
  }

  async downloadTo(entryIndex: number, destPath: string): Promise<void> {
    const url = await this.getDownloadUrl(entryIndex);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`crop download failed (HTTP ${res.status})`);
    await fs.promises.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  }

  // ── Manual overrides + one-shot listing (NEO-170) ────────────────────────
  // The reactive onImages/onPairs subscriptions drive the live UI, but the
  // idle-menu override actions want an authoritative snapshot at the moment the
  // operator acts, so these do one-shot queries against the same server
  // functions the subscriptions use.

  /** One-shot snapshot of every image in the job (not a subscription). */
  async listImages(): Promise<StreamImageRow[]> {
    return (await this.convex.query(qListImages, { jobId: this.requireJob() })) as StreamImageRow[];
  }

  /**
   * The "waiting for a partner" pool: images the server has finished
   * processing but has not paired. Each row carries entryIndex + identity
   * (players/team/cardNumber/side); fetch a crop preview for any of them with
   * getDownloadUrl(entryIndex) / downloadTo(entryIndex, dest).
   */
  async listWaitingImages(): Promise<StreamImageRow[]> {
    const rows = await this.listImages();
    return rows.filter((r) => r.status === 'done' && r.pairStatus !== 'paired');
  }

  /** One-shot snapshot of the server's current front/back pairs. */
  async listPairs(): Promise<StreamPairRow[]> {
    return (await this.convex.query(qListPairs, { jobId: this.requireJob() })) as StreamPairRow[];
  }

  /**
   * Correct a misread image's identity and re-trigger server-side pairing (a
   * fixed name auto-pairs to its partner). Only the fields supplied are
   * patched. Throws MissingBackendFunctionError if the backend hasn't renamed
   * to this mutation yet.
   */
  async updateImageIdentity(
    entryIndex: number,
    fields: { players?: string[]; team?: string; cardNumber?: string; side?: 'front' | 'back' },
  ): Promise<void> {
    const jobId = this.requireJob();
    try {
      await this.convex.mutation(fnUpdateImageIdentity, { jobId, entryIndex, ...fields });
    } catch (err) {
      this.rethrowIfMissing(err, 'placeholderPairing:updatePlaceholderImageIdentity');
      throw err;
    }
  }

  /**
   * Force-pair two `done` images regardless of identity. The pair is sticky
   * (survives later automatic re-pairing) and flows back over the pairs
   * subscription like any other pair. Throws MissingBackendFunctionError if the
   * backend hasn't renamed to this mutation yet.
   */
  async pairImages(frontIndex: number, backIndex: number): Promise<void> {
    const jobId = this.requireJob();
    try {
      await this.convex.mutation(fnManualPair, { jobId, frontIndex, backIndex });
    } catch (err) {
      this.rethrowIfMissing(err, 'placeholderPairing:manuallyPairPlaceholderImages');
      throw err;
    }
  }

  /**
   * Break a pair (manual or automatic) and free both images to pair again.
   * Throws MissingBackendFunctionError if the backend hasn't renamed to this
   * mutation yet.
   */
  async unpairImages(frontIndex: number, backIndex: number): Promise<void> {
    const jobId = this.requireJob();
    try {
      await this.convex.mutation(fnUnpair, { jobId, frontIndex, backIndex });
    } catch (err) {
      this.rethrowIfMissing(err, 'placeholderPairing:unpairPlaceholderImages');
      throw err;
    }
  }

  /**
   * If `err` is Convex's "could not find function" (the backend hasn't renamed
   * yet), log a status-only warning and throw the typed error so the caller can
   * surface it and continue. Any other error is left for the caller to rethrow.
   */
  private rethrowIfMissing(err: unknown, fn: string): void {
    if (isMissingFunctionError(err)) {
      debug(`backend function ${fn} is not available yet (not renamed/deployed) — no fallback`);
      throw new MissingBackendFunctionError(fn);
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.convex.close();
    } catch {
      // best-effort
    }
  }
}

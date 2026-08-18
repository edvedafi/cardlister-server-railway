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
 * Auth: the backend's mutations require a real Clerk identity. This client
 * signs in headlessly against the Clerk DEVELOPMENT instance:
 *   1. fetch a single-use sign-in ticket (either from the NeonBinder app's
 *      /api/auth/testing endpoint — dev/preview only, fail-closed on prod —
 *      or minted directly with a Clerk secret key),
 *   2. exchange the ticket at Clerk's Frontend API (strategy=ticket),
 *   3. mint short-lived "convex"-template session JWTs on demand for
 *      ConvexClient.setAuth's refresh callback.
 * No secret is ever logged, even truncated.
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
//   adapters/placeholderUploads.ts

const fnStartStream = makeFunctionReference<'mutation'>('placeholderStream:startPlaceholderStream');
const fnConfirmUpload = makeFunctionReference<'mutation'>('placeholderStream:confirmPlaceholderImageUpload');
const fnCloseStream = makeFunctionReference<'mutation'>('placeholderStream:closePlaceholderStream');
const fnCreateImageUploadUrl = makeFunctionReference<'action'>(
  'adapters/placeholderUploads:createPlaceholderImageUploadUrl',
);
const fnCreateImageDownloadUrl = makeFunctionReference<'action'>(
  'adapters/placeholderUploads:createPlaceholderImageDownloadUrl',
);
const qGetJob = makeFunctionReference<'query'>('placeholderPipeline:getPlaceholderJob');
const qListImages = makeFunctionReference<'query'>('placeholderPipeline:listPlaceholderImages');
const qListPairs = makeFunctionReference<'query'>('placeholderPipeline:listPlaceholderPairs');

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

// ── Clerk error rendering (never logs bodies — they can carry tokens) ──────

interface ClerkErrorBody {
  errors?: { code?: string; message?: string; long_message?: string }[];
}

const clerkErrorSummary = async (res: Response): Promise<string> => {
  let detail = '';
  try {
    const body = (await res.json()) as ClerkErrorBody;
    const first = body.errors?.[0];
    if (first) detail = ` — ${first.code ?? ''}: ${first.long_message ?? first.message ?? ''}`;
  } catch {
    // Non-JSON error body; status alone will have to do. Deliberately not
    // echoing raw text — Clerk responses can embed tokens.
  }
  return `HTTP ${res.status}${detail}`;
};

// ── Ticket sources ─────────────────────────────────────────────────────────

interface ClerkTicket {
  signInToken: string;
  testingToken?: string;
}

/**
 * Primary source: the NeonBinder app's testing-auth endpoint
 * (apps/web/api/auth/testing.ts — dev/preview only, allowlisted accounts,
 * hard 404 on production by design).
 */
const fetchTicketFromTestingEndpoint = async (): Promise<ClerkTicket> => {
  const appUrl = requireEnv('NEONBINDER_APP_URL', 'needed to reach /api/auth/testing');
  const secret = requireEnv('NEONBINDER_TESTING_SECRET', 'the x-testing-auth header value');
  const account = env('NEONBINDER_TEST_ACCOUNT') ?? 'main';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-testing-auth': secret,
  };
  // Vercel preview URLs sit behind deployment protection; the bypass header
  // lets a headless client through. Not needed for a local vite dev server.
  const bypass = env('NEONBINDER_VERCEL_BYPASS');
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;

  const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/auth/testing`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ account }),
  });
  if (!res.ok) {
    throw new Error(
      `NeonBinder testing-auth endpoint refused the request (${await clerkErrorSummary(res)}). ` +
        `Check NEONBINDER_APP_URL, NEONBINDER_TESTING_SECRET, and (for Vercel previews) NEONBINDER_VERCEL_BYPASS.`,
    );
  }
  const body = (await res.json()) as { signInToken?: string; testingToken?: string };
  if (!body.signInToken) {
    throw new Error('testing-auth endpoint responded without a signInToken');
  }
  debug(`Obtained sign-in ticket for test account "${account}"`);
  return { signInToken: body.signInToken, testingToken: body.testingToken };
};

/**
 * Secondary source: mint a sign-in token directly with a Clerk secret key
 * (mirrors apps/web/lib/testing/issue-clerk-tokens.ts). Lets the CLI act as
 * any real user of the instance — used when NEONBINDER_CLERK_SECRET_KEY and
 * NEONBINDER_USER_EMAIL are both set.
 */
const fetchTicketDirect = async (): Promise<ClerkTicket> => {
  const secretKey = requireEnv('NEONBINDER_CLERK_SECRET_KEY', 'Clerk Backend API key');
  const email = requireEnv('NEONBINDER_USER_EMAIL', 'the user to sign in as');
  const auth = { Authorization: `Bearer ${secretKey}` };

  const usersRes = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: auth },
  );
  if (!usersRes.ok) {
    throw new Error(`Clerk user lookup failed (${await clerkErrorSummary(usersRes)})`);
  }
  const users = (await usersRes.json()) as { id: string }[];
  if (!users.length) throw new Error(`No Clerk user found for ${email}`);

  const tokenRes = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: users[0].id, expires_in_seconds: 120 }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Clerk sign-in token mint failed (${await clerkErrorSummary(tokenRes)})`);
  }
  const token = (await tokenRes.json()) as { token?: string };
  if (!token.token) throw new Error('Clerk sign-in token response carried no token');
  debug(`Minted sign-in ticket directly for ${email}`);
  return { signInToken: token.token };
};

// ── Headless Clerk session (development-instance Frontend API) ─────────────

class ClerkHeadlessSession {
  private fapi: string;
  private devBrowserJwt: string | null = null;
  private clientToken: string | null = null;
  private sessionId: string | null = null;

  constructor(fapiUrl: string) {
    this.fapi = fapiUrl.replace(/\/$/, '');
  }

  /** Query-string auth params for a development-instance Frontend API call. */
  private authParams(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ _is_native: '1', ...extra });
    if (this.devBrowserJwt) params.set('__clerk_db_jwt', this.devBrowserJwt);
    return params.toString();
  }

  private authHeaders(): Record<string, string> {
    return this.clientToken ? { Authorization: this.clientToken } : {};
  }

  /** Capture the rotating client token Clerk returns on native flows. */
  private captureClientToken(res: Response): void {
    const token = res.headers.get('authorization');
    if (token) this.clientToken = token;
  }

  async establish(ticket: ClerkTicket): Promise<void> {
    // Development instances identify the "browser" via a dev-browser JWT.
    // Best-effort: if the endpoint is absent (non-dev instance), continue —
    // the sign-in call below will tell us definitively whether we're stuck.
    try {
      const res = await fetch(`${this.fapi}/v1/dev_browser`, { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as { token?: string; id?: string };
        if (body.token) {
          this.devBrowserJwt = body.token;
          debug('Established Clerk dev-browser context');
        }
      } else {
        debug(`Clerk dev_browser unavailable (HTTP ${res.status}) — continuing without`);
      }
    } catch (err) {
      debug(`Clerk dev_browser request failed — continuing without (${String(err)})`);
    }

    const extra: Record<string, string> = {};
    if (ticket.testingToken) extra['__clerk_testing_token'] = ticket.testingToken;
    const res = await fetch(`${this.fapi}/v1/client/sign_ins?${this.authParams(extra)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...this.authHeaders(),
      },
      body: new URLSearchParams({ strategy: 'ticket', ticket: ticket.signInToken }).toString(),
    });
    this.captureClientToken(res);
    if (!res.ok) {
      throw new Error(
        `Clerk sign-in (ticket) failed (${await clerkErrorSummary(res)}). ` +
          `Check NEONBINDER_CLERK_FAPI_URL points at the same Clerk instance the app uses.`,
      );
    }
    const body = (await res.json()) as {
      response?: { created_session_id?: string; status?: string };
      created_session_id?: string;
      status?: string;
      client?: { sessions?: { id: string }[] };
    };
    const signIn = body.response ?? body;
    this.sessionId =
      signIn.created_session_id ?? body.client?.sessions?.[0]?.id ?? null;
    if (!this.sessionId) {
      throw new Error(
        `Clerk sign-in did not yield a session (status: ${signIn.status ?? 'unknown'})`,
      );
    }
    debug('Clerk headless session established');
  }

  /**
   * Mint a short-lived Convex-audience JWT (the "convex" JWT template — the
   * same one ConvexProviderWithClerk requests in the web app). Called by
   * ConvexClient's auth refresh loop, so it must stay cheap and quiet.
   */
  async mintConvexJwt(): Promise<string | null> {
    if (!this.sessionId) return null;
    // The whole body is wrapped: a fetch REJECTION (DNS/TLS/socket) carries
    // the request URL — whose query string holds the dev-browser JWT — in its
    // cause/stack, and letting it escape into ConvexClient's auth refresh
    // loop would land that in the persistent debug log. Status-only on every
    // failure path.
    try {
      const res = await fetch(
        `${this.fapi}/v1/client/sessions/${this.sessionId}/tokens/convex?${this.authParams()}`,
        { method: 'POST', headers: this.authHeaders() },
      );
      this.captureClientToken(res);
      if (!res.ok) {
        debug(`Convex JWT mint failed (${await clerkErrorSummary(res)})`);
        return null;
      }
      const body = (await res.json()) as { jwt?: string; object?: string };
      return body.jwt ?? null;
    } catch (err) {
      debug(
        `Convex JWT mint failed (network: ${err instanceof Error ? err.constructor.name : 'unknown'})`,
      );
      return null;
    }
  }
}

// ── The client ─────────────────────────────────────────────────────────────

export class NeonBinderStreamClient {
  private convex: ConvexClient;
  private session: ClerkHeadlessSession;
  jobId: string | null = null;
  private closed = false;

  private constructor(convex: ConvexClient, session: ClerkHeadlessSession) {
    this.convex = convex;
    this.session = session;
  }

  /** Connect, authenticate, and verify the token round-trip. */
  static async connect(): Promise<NeonBinderStreamClient> {
    const convexUrl = requireEnv('NEONBINDER_CONVEX_URL', 'the Convex deployment to stream into');
    const fapiUrl = requireEnv(
      'NEONBINDER_CLERK_FAPI_URL',
      'the Clerk Frontend API host (e.g. https://<slug>.clerk.accounts.dev)',
    );

    const useDirect = !!(env('NEONBINDER_CLERK_SECRET_KEY') && env('NEONBINDER_USER_EMAIL'));
    const ticket = useDirect ? await fetchTicketDirect() : await fetchTicketFromTestingEndpoint();

    const session = new ClerkHeadlessSession(fapiUrl);
    await session.establish(ticket);

    // Fail loudly now rather than on the first mutation.
    const probe = await session.mintConvexJwt();
    if (!probe) {
      throw new Error(
        'Clerk session established but minting a "convex"-template JWT failed — ' +
          'verify the Clerk instance has a JWT template named "convex".',
      );
    }

    const webSocketConstructor =
      typeof WebSocket !== 'undefined'
        ? undefined
        : ((await import('ws')).default as unknown as typeof WebSocket);
    const convex = new ConvexClient(convexUrl, {
      ...(webSocketConstructor ? { webSocketConstructor } : {}),
    });
    convex.setAuth(async () => session.mintConvexJwt());

    debug(`Connected to ${convexUrl}`);
    return new NeonBinderStreamClient(convex, session);
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

  async disconnect(): Promise<void> {
    try {
      await this.convex.close();
    } catch {
      // best-effort
    }
  }
}

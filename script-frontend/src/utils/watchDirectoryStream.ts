/**
 * Streaming-mode directory watcher (NEO-170).
 *
 * The server-matched counterpart of watchDirectory.ts: file detection,
 * debounce, stability-wait, scanned.txt semantics and the idle waiting menu
 * are the same, but the intake work item is just "upload + confirm" — the
 * NeonBinder backend does all cropping, identity extraction, and front/back
 * pairing. Pairs arrive over a reactive subscription; when one lands we
 * download both cropped outputs and hand them to the same onPairReady the
 * legacy watcher uses, so the review/finalize chain in listSet.ts is
 * untouched.
 *
 * The local CardPool is deliberately unused here: pairing authority lives
 * server-side, and a client-side mirror would drift. The idle menu's manual
 * override actions therefore operate on live remote state via the client's
 * override mutations: (V)iew the waiting pool with image previews, (P) fix a
 * misread identity so the server re-pairs, (M)anually force a pair, and
 * (U)npair a wrong one. Pairing stays identity-first and automatic; these are
 * the operator's escape hatch when the model misreads a card.
 */
import fs from 'fs';
import path from 'path';
import readline from 'node:readline';
import Queue from 'queue';
import terminalImage from 'term-img';
import { useSpinners } from './spinners.js';
import chalk from 'chalk';
import type { CardSide, MatchResult, UnmatchedCard } from './cardPool.js';
import { ask, queuedLog } from './ask.js';
import { createLogger } from './logger.js';
import { terminalLink } from './terminalLink.js';
import { MissingBackendFunctionError } from './neonbinder-stream.js';
import {
  setWaitingTaskFactory,
  setWaitingAbort,
  abortWaitingTask,
  markSessionComplete,
  isSessionComplete,
  markCtrlCPressed,
  startUILoop,
} from './uiQueue.js';
import type { DirectoryWatcher } from './watchDirectory.js';
import type {
  NeonBinderStreamClient,
  StreamImageRow,
  StreamJobSnapshot,
  StreamPairRow,
} from './neonbinder-stream.js';

const { showSpinner, log } = useSpinners('watch', chalk.magenta);
const debug = createLogger('watch-stream');

async function waitForFileStable(filePath: string, interval = 100, maxWait = 10000): Promise<boolean> {
  let lastSize = -1;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0 && stat.size === lastSize) return true;
      lastSize = stat.size;
    } catch {
      // file not accessible yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export interface StreamWatcherOptions {
  directory: string;
  knownFiles: Set<string>;
  scannedFiles?: Map<string, number>;
  initialFiles?: string[];
  /** Connected client with an OPEN stream job (startStream already called). */
  client: NeonBinderStreamClient;
  /** Where downloaded pair crops land (cleaned up by the caller). */
  downloadDir: string;
  /**
   * Register a downloaded/derived basename → original scan basename mapping
   * so listSet's markScanned resolves finalize-time paths back to the raw
   * input file. (Callback rather than an import to avoid a module cycle.)
   */
  registerOriginalName: (derivedBasename: string, originalBasename: string) => void;
  /** Mark a local file as scanned/abandoned (mirrors legacy onSkip). */
  onSkip?: (imagePath: string) => void;
  /** Same contract as SmartWatcherOptions.onPairReady. */
  onPairReady: (front: string, back: string, match: MatchResult) => Promise<void>;
  setLink?: { label: string; url: string };
}

interface TrackedEntry {
  localPath: string;
  basename: string;
  spinner: ReturnType<ReturnType<typeof useSpinners>['showSpinner']>;
  lastStatus: StreamImageRow['status'] | 'uploading';
  row?: StreamImageRow;
}

const describeRow = (row: StreamImageRow | undefined): string => {
  if (!row) return '';
  const player = row.players?.[0];
  return (
    (row.side ?? '?') +
    (player ? ` — ${player}` : '') +
    (row.team ? ` (${row.team})` : '') +
    (row.cardNumber ? ` #${row.cardNumber}` : '')
  );
};

export function watchWithServerMatching(opts: StreamWatcherOptions): DirectoryWatcher {
  const {
    directory,
    knownFiles,
    scannedFiles,
    initialFiles = [],
    client,
    downloadDir,
    registerOriginalName,
    onSkip,
    onPairReady,
    setLink,
  } = opts;

  const recentlySeen = new Map<string, number>();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let resolveCompletion: (() => void) | null = null;

  // entryIndex → local file + live spinner. Only CONFIRMED uploads are here.
  const entries = new Map<number, TrackedEntry>();
  // Latest reactive state, rendered by the idle header.
  let latestJob: StreamJobSnapshot | null = null;
  let latestImages: StreamImageRow[] = [];
  let latestPairs: StreamPairRow[] = [];
  // Pair keys already seen and entry indexes already handed to review — a
  // server-side pair revision that would re-review a physical scan is skipped.
  const seenPairs = new Set<string>();
  const handedOff = new Set<number>();
  // entryIndex → the pair it belongs to, so a review-time reject (reAddToPool)
  // can break the right server pair, and the unpair action can free both sides.
  const pairByEntry = new Map<number, StreamPairRow>();
  // Server entries the operator rejected in review (the wrong half of a pair).
  // Unpairing alone does NOT settle this: both sides stay `done` on the server
  // with their identities unchanged, so the next pairing run re-forms the exact
  // same pair and review reopens on what we just rejected. There is no
  // server-side discard mutation, so the dead scan is tombstoned locally — it
  // never reaches review again and never shows in the waiting pool. The
  // physical card is rescanned and comes back under a fresh entryIndex.
  const rejectedEntries = new Set<number>();
  // Pair keys the operator separated with review-menu (U): two different cards
  // that were wrongly paired. Unlike a reject, BOTH images stay alive and go
  // back to the pool — only this exact pairing is dead. The server will keep
  // re-proposing it (nothing about either image changed), so the ban is what
  // makes the separation stick.
  const bannedPairs = new Set<string>();
  // pair key → how many times we've re-broken a pair the server keeps
  // re-forming around a rejected or banned entry. Bounded so a server that
  // insists on the pairing can't turn this into an unpair/re-pair ping-pong.
  const reUnpairAttempts = new Map<string, number>();
  const MAX_RE_UNPAIR = 3;

  const pairKey = (frontIndex: number, backIndex: number): string => `${frontIndex}-${backIndex}`;

  /** A pairing the operator has already thrown out, by either route. */
  const isSuppressedPair = (pair: StreamPairRow): boolean =>
    rejectedEntries.has(pair.frontIndex) ||
    rejectedEntries.has(pair.backIndex) ||
    bannedPairs.has(pairKey(pair.frontIndex, pair.backIndex));
  // entryIndex → local downloaded crop path, so pool previews don't re-download
  // the same image on every idle-menu action.
  const previewCache = new Map<number, string>();
  let lastIdleRenderKey = '';
  const unsubscribers: (() => void)[] = [];

  // A `done` image the server has NOT paired. Prefer the server's authoritative
  // pairStatus; fall back to our own handoff tracking on an older backend that
  // doesn't emit it. This is the shared definition of the "waiting pool".
  const isWaiting = (r: StreamImageRow): boolean =>
    !rejectedEntries.has(r.entryIndex) &&
    r.status === 'done' &&
    (r.pairStatus ? r.pairStatus !== 'paired' : !handedOff.has(r.entryIndex));

  // Same concurrency knob as the legacy watcher. Upload bandwidth is still
  // the practical bottleneck — the server absorbs bursts via its workpool.
  const intakeConcurrency = Math.max(1, Number(process.env.INTAKE_CONCURRENCY) || 10);
  const intakeQueue = new Queue({ autostart: true, concurrency: intakeConcurrency, results: [] });

  let resolveIntakeIdle: (() => void) | null = null;
  const intakeIdlePromise = new Promise<void>((resolve) => {
    resolveIntakeIdle = resolve;
  });

  intakeQueue.addEventListener('end', () => {
    if (resolveIntakeIdle) {
      resolveIntakeIdle();
      resolveIntakeIdle = null;
    }
    abortWaitingTask();
  });

  /** Re-render the idle screen when the remote counts actually changed. */
  const maybeRefreshIdle = () => {
    const j = latestJob;
    const key = j
      ? `${j.status}|${j.totalImages}|${j.processedImages}|${j.failedImages}|${j.pairCount}`
      : '';
    if (key !== lastIdleRenderKey) {
      lastIdleRenderKey = key;
      abortWaitingTask();
    }
  };

  // ── Intake: upload + confirm ─────────────────────────────────────────────

  const isAlreadyScanned = (filePath: string): boolean => {
    if (!scannedFiles) return false;
    const recorded = scannedFiles.get(path.basename(filePath));
    if (recorded === undefined) return false;
    if (recorded === 0) return true;
    try {
      return fs.statSync(filePath).mtimeMs <= recorded;
    } catch {
      return true;
    }
  };

  const enqueueFile = (filePath: string) => {
    if (isAlreadyScanned(filePath)) {
      debug(`Skipping already-scanned file: ${path.basename(filePath)}`);
      return;
    }

    intakeQueue.push(async () => {
      if (stopped) return;
      const basename = path.basename(filePath);
      const spinner = showSpinner(`intake-${basename}`, `Processing ${basename}`);
      try {
        spinner.update('Requesting upload slot');
        const alloc = await client.allocateUpload(basename);
        if (stopped) {
          spinner.finish();
          return;
        }
        spinner.update('Uploading');
        await client.uploadFile(alloc, filePath);
        // Registered BEFORE the confirm: confirm is idempotent server-side,
        // but if its response is lost after the server processed it, an
        // unregistered mapping would orphan this entry (spinner never
        // finishes, file re-uploaded as a duplicate next run).
        entries.set(alloc.entryIndex, {
          localPath: filePath,
          basename,
          spinner,
          lastStatus: 'queued',
        });
        spinner.update('Confirming');
        await client.confirmUpload(alloc.entryIndex);
        spinner.update('Queued remotely');
        debug(`Uploaded ${basename} as entry ${alloc.entryIndex}`);
        // The spinner stays live — the images subscription finishes it when
        // the server reports done/failed for this entry.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug(`Upload failed for ${basename}: ${msg}`);
        // NOT marked scanned — the file is retried on the next run.
        spinner.error(`Upload failed: ${msg}`);
      }
    });
  };

  const handleNewFile = (filePath: string) => {
    if (stopped) return;
    if (knownFiles.has(filePath)) return;
    if (!filePath.toLowerCase().endsWith('.jpg')) return;
    if (path.resolve(path.dirname(filePath)) !== path.resolve(directory)) {
      knownFiles.add(filePath);
      return;
    }
    if (isAlreadyScanned(filePath)) {
      debug(`Skipping already-scanned file: ${path.basename(filePath)}`);
      knownFiles.add(filePath);
      return;
    }

    const now = Date.now();
    const lastSeen = recentlySeen.get(filePath);
    if (lastSeen && now - lastSeen < 500) return;
    recentlySeen.set(filePath, now);
    if (recentlySeen.size > 200) {
      const cutoff = now - 60_000;
      for (const [key, ts] of recentlySeen) {
        if (ts < cutoff) recentlySeen.delete(key);
      }
    }

    void (async () => {
      const stable = await waitForFileStable(filePath);
      if (stopped || !stable) return;
      knownFiles.add(filePath);
      debug(`New file detected: ${path.basename(filePath)}`);
      enqueueFile(filePath);
    })();
  };

  // ── Reactive state → spinners and pair handoff ───────────────────────────

  const onImagesUpdate = (rows: StreamImageRow[]) => {
    latestImages = rows;
    for (const row of rows) {
      const entry = entries.get(row.entryIndex);
      if (!entry) continue;
      entry.row = row;
      if (row.status === entry.lastStatus) continue;
      entry.lastStatus = row.status;
      if (row.status === 'processing') {
        entry.spinner.update('Processing remotely');
      } else if (row.status === 'done') {
        entry.spinner.finish(describeRow(row));
      } else if (row.status === 'failed') {
        entry.spinner.error(`${row.errorCode ?? 'processing failed'} — ${entry.basename} will not be listed`);
      }
    }
    maybeRefreshIdle();
  };

  // Runs on pairQueue (concurrency 3): a terminal pairing run can deliver
  // hundreds of pairs in one subscription update, and each handoff costs a
  // Convex action plus two GCS downloads — the failure mode to bound is
  // unbounded fan-out from one CLI, not handoff latency.
  const pairQueue = new Queue({ autostart: true, concurrency: 3, results: [] });

  const handlePair = async (pair: StreamPairRow) => {
    if (stopped) return;
    if (isSuppressedPair(pair)) return;
    const key = pairKey(pair.frontIndex, pair.backIndex);
    if (handedOff.has(pair.frontIndex) || handedOff.has(pair.backIndex)) {
      // The server revised a provisional pair after we already sent one of
      // its sides to review. Reviewing the same physical scan twice is worse
      // than keeping the first pairing — skip, loudly.
      log(
        chalk.yellow(
          `Server revised pair #${pair.frontIndex}↔#${pair.backIndex} after review started — keeping the original pairing`,
        ),
      );
      return;
    }
    handedOff.add(pair.frontIndex);
    handedOff.add(pair.backIndex);
    pairByEntry.set(pair.frontIndex, pair);
    pairByEntry.set(pair.backIndex, pair);

    const frontEntry = entries.get(pair.frontIndex);
    const backEntry = entries.get(pair.backIndex);
    const title = pair.player ?? frontEntry?.basename ?? `#${pair.frontIndex}`;
    const spinner = showSpinner(`pair-${key}`, `Pair matched: ${title}`);
    try {
      spinner.update('Downloading crops');
      const frontPath = path.join(downloadDir, `pair-${pair.frontIndex}-front.jpg`);
      const backPath = path.join(downloadDir, `pair-${pair.backIndex}-back.jpg`);
      // Prefer the server's cropped outputs; fall back to the raw local scans
      // so a download hiccup degrades to "review the uncropped image" (the
      // menu's re-crop action still works from the original) instead of
      // stalling the pair.
      const materialize = async (entryIndex: number, dest: string, local?: TrackedEntry): Promise<string> => {
        try {
          await client.downloadTo(entryIndex, dest);
          if (local) registerOriginalName(path.basename(dest), local.basename);
          return dest;
        } catch (err) {
          debug(`Crop download failed for entry ${entryIndex}: ${String(err)}`);
          if (!local) throw err;
          log(chalk.yellow(`Using local scan for ${local.basename} (crop download failed)`));
          return local.localPath;
        }
      };
      const [frontFile, backFile] = await Promise.all([
        materialize(pair.frontIndex, frontPath, frontEntry),
        materialize(pair.backIndex, backPath, backEntry),
      ]);

      const rowFor = (entryIndex: number): StreamImageRow | undefined =>
        entries.get(entryIndex)?.row ?? latestImages.find((r) => r.entryIndex === entryIndex);
      const buildCard = (
        entryIndex: number,
        side: CardSide,
        filePath: string,
        local?: TrackedEntry,
      ): UnmatchedCard => {
        const row = rowFor(entryIndex);
        return {
          path: filePath,
          side,
          player: pair.player ?? row?.players?.[0] ?? null,
          team: pair.team ?? row?.team ?? null,
          cardNumber: pair.cardNumber ?? row?.cardNumber ?? null,
          textDetectionCount: row?.textCount ?? 0,
          timestamp: Date.now(),
          originalFilename: local?.basename,
          originalPath: local?.localPath,
        };
      };

      const match: MatchResult = {
        front: buildCard(pair.frontIndex, 'front', frontFile, frontEntry),
        back: buildCard(pair.backIndex, 'back', backFile, backEntry),
        confidence: pair.confidence,
      };
      spinner.finish(`${title} (${pair.confidence}, ${pair.mechanism})`);
      onPairReady(frontFile, backFile, match).catch((err) => {
        debug(`onPairReady failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      spinner.error(`Pair handoff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onPairsUpdate = (rows: StreamPairRow[]) => {
    latestPairs = rows;
    for (const pair of rows) {
      // Deduped at ENQUEUE time so a burst of subscription updates cannot
      // queue the same pair twice before its first task runs.
      const key = pairKey(pair.frontIndex, pair.backIndex);
      // A pairing the operator already threw out. Nothing about the two images
      // changed when we unpaired them, so the server keeps re-forming it —
      // this is the guard that stops reject → re-pair → same review, forever.
      if (isSuppressedPair(pair)) {
        void reBreakSuppressedPair(pair);
        continue;
      }
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pairQueue.push(() => handlePair(pair));
    }
    maybeRefreshIdle();
  };

  // ── Idle waiting task ────────────────────────────────────────────────────

  const printWaitingHeader = async () => {
    await queuedLog('');
    await queuedLog(chalk.green.bold('All cards uploaded. Waiting for new cards...'));
    await queuedLog(chalk.green('  Add .jpg files to the input directory to continue processing.'));
    if (setLink) {
      await queuedLog(
        chalk.cyan(`  ${setLink.label}: `) + terminalLink(setLink.url, chalk.cyan.underline(setLink.url)),
      );
    }
    const j = latestJob;
    if (j) {
      const inFlight = j.totalImages - j.processedImages - j.failedImages;
      await queuedLog(
        chalk.cyan(
          `  Session: ${j.totalImages} uploaded, ${inFlight > 0 ? `${inFlight} processing, ` : ''}` +
            `${j.pairCount} pair(s) matched` +
            (j.failedImages > 0 ? chalk.red(`, ${j.failedImages} failed`) : ''),
        ),
      );
    }
    const unpaired = latestImages.filter(isWaiting);
    if (unpaired.length > 0) {
      await queuedLog(chalk.yellow(`  ${unpaired.length} card(s) waiting for a partner:`));
      for (const row of unpaired) {
        const local = entries.get(row.entryIndex);
        await queuedLog(
          chalk.yellow(`    #${row.entryIndex} ${local?.basename ?? row.originalName}: ${describeRow(row)}`),
        );
      }
      await queuedLog(
        chalk.dim('  Press V to preview them, P to fix an identity, M to pair two by hand, or X to clear them all.'),
      );
    }
    await queuedLog('');
  };

  // ── Pool preview + override actions (NEO-170 manual intervention) ─────────
  // The whole point of previews: the operator can't trust a misread name, so
  // show the actual crop. Downloads the server's cropped output for an entry
  // and renders it inline (same term-img approach the legacy watcher used for
  // local pool cards); caches the download so repeated menu actions don't
  // re-fetch. Returns the rendered block, or null if it couldn't be shown.
  const renderPreview = async (entryIndex: number): Promise<string | null> => {
    try {
      let file = previewCache.get(entryIndex);
      if (!file || !fs.existsSync(file)) {
        file = path.join(downloadDir, `preview-${entryIndex}.jpg`);
        await client.downloadTo(entryIndex, file);
        previewCache.set(entryIndex, file);
      }
      const out = await terminalImage(file, { height: 12 });
      return '    ' + out;
    } catch (err) {
      debug(`Preview render failed for entry ${entryIndex}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  /**
   * True when `entryIndex` is held in a pair whose other half was rejected.
   * The server believes it is paired, so it drops out of the waiting pool —
   * but its real partner is the rescan that hasn't arrived yet, which makes it
   * exactly the card the operator needs to reach from the pairing menu.
   */
  const isStrandedBySuppression = (entryIndex: number): boolean => {
    if (rejectedEntries.has(entryIndex)) return false;
    const pair = latestPairs.find((p) => p.frontIndex === entryIndex || p.backIndex === entryIndex);
    return !!pair && isSuppressedPair(pair);
  };

  /**
   * The server re-formed a pair around a rejected scan. Break it again so the
   * kept side is free to pair with the incoming rescan. Bounded: if the server
   * keeps insisting, stop fighting it and point at the manual pair action —
   * `isStrandedByRejection` keeps the kept side reachable there either way.
   */
  const reBreakSuppressedPair = async (pair: StreamPairRow): Promise<void> => {
    const key = pairKey(pair.frontIndex, pair.backIndex);
    const attempts = reUnpairAttempts.get(key) ?? 0;
    if (attempts >= MAX_RE_UNPAIR) return;
    reUnpairAttempts.set(key, attempts + 1);
    try {
      await client.unpairImages(pair.frontIndex, pair.backIndex);
      unpairLocal(pair.frontIndex, pair.backIndex);
      debug(`Re-broke suppressed pair ${key} (attempt ${attempts + 1})`);
    } catch (err) {
      debug(`Re-break of suppressed pair ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (attempts + 1 >= MAX_RE_UNPAIR) {
      const discarded = rejectedEntries.has(pair.frontIndex)
        ? pair.frontIndex
        : rejectedEntries.has(pair.backIndex)
          ? pair.backIndex
          : null;
      log(
        chalk.yellow(
          `The server keeps re-pairing #${pair.frontIndex}↔#${pair.backIndex}, which you already separated. ` +
            (discarded === null
              ? `Both sides stay reachable from the idle menu — use (M)pair to pair them by hand.`
              : `Rescan the rejected side, then use the idle menu's (M)pair to pair it with ` +
                `#${discarded === pair.frontIndex ? pair.backIndex : pair.frontIndex} by hand.`),
        ),
      );
    }
  };

  /** Authoritative waiting pool at action time; falls back to live state. */
  const listWaitingPool = async (): Promise<StreamImageRow[]> => {
    const withStranded = (rows: StreamImageRow[]): StreamImageRow[] => {
      const usable = rows.filter((r) => !rejectedEntries.has(r.entryIndex));
      if (rejectedEntries.size === 0 && bannedPairs.size === 0) return usable;
      const present = new Set(usable.map((r) => r.entryIndex));
      const stranded = latestImages.filter(
        (r) => r.status === 'done' && !present.has(r.entryIndex) && isStrandedBySuppression(r.entryIndex),
      );
      return [...usable, ...stranded];
    };
    try {
      // The server still counts a rejected scan as waiting (it has no idea we
      // threw it away) and still counts its ex-partner as paired, so both
      // corrections apply to the server's answer too.
      return withStranded(await client.listWaitingImages());
    } catch (err) {
      debug(`listWaitingImages failed, using cached subscription state: ${err instanceof Error ? err.message : String(err)}`);
      return withStranded(latestImages.filter(isWaiting));
    }
  };

  const poolLabel = (row: StreamImageRow): string => {
    const local = entries.get(row.entryIndex);
    const name = local?.basename ?? row.originalName;
    return `#${row.entryIndex} ${name} — ${describeRow(row) || chalk.red('unknown')}`;
  };

  /** List the waiting pool with an inline image preview for each card. */
  const printPoolWithPreviews = async (pool: StreamImageRow[]): Promise<void> => {
    if (pool.length === 0) {
      await queuedLog(chalk.dim('  No cards are waiting for a partner right now.'));
      return;
    }
    await queuedLog(chalk.yellow.bold(`  ${pool.length} card(s) waiting for a partner:`));
    for (const row of pool) {
      await queuedLog('');
      const preview = await renderPreview(row.entryIndex);
      if (preview) await queuedLog(preview);
      await queuedLog(chalk.yellow(`    ${poolLabel(row)}`));
    }
    await queuedLog('');
  };

  /**
   * Prompt the operator to pick one waiting card via the existing ask() select
   * (arrow keys + Enter, Escape to cancel). Returns the entryIndex, or null if
   * cancelled / nothing to pick.
   */
  const pickCard = async (message: string, pool: StreamImageRow[]): Promise<number | null> => {
    if (pool.length === 0) return null;
    const choice = await ask(message, undefined, {
      selectOptions: pool.map((row) => ({ name: poolLabel(row), value: String(row.entryIndex) })),
    });
    if (choice === undefined || choice === null || choice === '') return null;
    return Number(choice);
  };

  /**
   * Map a review-menu card back to the server entry it was uploaded as. The
   * menu hands back downloaded crops (and re-crop temp files), so the local
   * scan it originated from is the only stable link.
   */
  const resolveEntry = (card: UnmatchedCard): number | undefined => {
    for (const [idx, e] of entries) {
      if (
        (card.originalFilename && e.basename === card.originalFilename) ||
        (card.originalPath && e.localPath === card.originalPath)
      ) {
        return idx;
      }
    }
    return undefined;
  };

  /** Forget a broken pair locally so both sides re-enter the waiting pool. */
  const unpairLocal = (frontIndex: number, backIndex: number): void => {
    seenPairs.delete(`${frontIndex}-${backIndex}`);
    handedOff.delete(frontIndex);
    handedOff.delete(backIndex);
    pairByEntry.delete(frontIndex);
    pairByEntry.delete(backIndex);
  };

  // View the waiting pool with previews (idle-menu 'v').
  const viewPoolAction = async (): Promise<void> => {
    await printPoolWithPreviews(await listWaitingPool());
  };

  // Correct a misread identity, then let the server re-pair (idle-menu 'p').
  const editIdentityAction = async (): Promise<void> => {
    const pool = await listWaitingPool();
    if (pool.length === 0) {
      await queuedLog(chalk.dim('  No cards are waiting for a partner right now.'));
      return;
    }
    await printPoolWithPreviews(pool);
    const entryIndex = await pickCard('Pick the card to fix', pool);
    if (entryIndex === null) {
      await queuedLog(chalk.dim('  Cancelled.'));
      return;
    }
    const row = pool.find((r) => r.entryIndex === entryIndex);
    if (!row) return;

    // Only fields the operator actually changes are patched.
    const patch: { players?: string[]; team?: string; cardNumber?: string; side?: 'front' | 'back' } = {};

    const currentPlayers = (row.players ?? []).join(', ');
    const playersAns = String((await ask('Player(s), comma-separated', currentPlayers)) ?? '');
    if (playersAns.trim() !== currentPlayers.trim()) {
      patch.players = playersAns.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const currentTeam = row.team ?? '';
    const teamAns = String((await ask('Team', currentTeam)) ?? '').trim();
    if (teamAns !== currentTeam.trim()) patch.team = teamAns;

    const currentCard = row.cardNumber ?? '';
    const cardAns = String((await ask('Card number', currentCard)) ?? '').trim();
    if (cardAns !== currentCard.trim()) patch.cardNumber = cardAns;

    const currentSide = row.side === 'front' || row.side === 'back' ? row.side : undefined;
    const sideAns = (await ask('Side', currentSide ?? 'front', {
      selectOptions: [
        { name: 'front', value: 'front' },
        { name: 'back', value: 'back' },
      ],
    })) as 'front' | 'back' | undefined;
    if (sideAns && sideAns !== currentSide) patch.side = sideAns;

    if (Object.keys(patch).length === 0) {
      await queuedLog(chalk.dim('  No changes — nothing sent.'));
      return;
    }

    await client.updateImageIdentity(entryIndex, patch);
    await queuedLog(chalk.dim(`  Updated #${entryIndex} — asking the server to re-pair…`));
    // Give the pairing subscription a moment to reflect the re-pair before we
    // report. If it paired, onPairsUpdate has already opened its review.
    await new Promise((r) => setTimeout(r, 1500));
    const stillWaiting = (await listWaitingPool()).some((r) => r.entryIndex === entryIndex);
    if (stillWaiting) {
      await queuedLog(chalk.yellow(`  #${entryIndex} is still waiting for a partner after the edit.`));
    } else {
      await queuedLog(chalk.green(`  #${entryIndex} paired after the edit — its review will open shortly.`));
    }
  };

  /**
   * Server pairs holding either of the operator's picks, keyed by pick.
   *
   * The waiting pool is a SNAPSHOT and automatic pairing never stops. Printing
   * previews and working two selects takes as long as the operator takes, and
   * a card that was waiting when the list rendered can be paired by the server
   * before the second Enter lands — identity-first pairing needs only the
   * partner's scan to finish processing. The backend then refuses the manual
   * pair ('image is already paired — unpair it first'), which is the correct
   * call but leaves the operator with a bare refusal and no idea which of the
   * two picks moved. Resolving it here names the culprit and clears it.
   *
   * A pick surfaced by `isStrandedBySuppression` lands here too, by design:
   * the server considers it paired (to a scan we threw away), which is exactly
   * why it was offered in the pool and exactly what has to be broken first.
   */
  const pairsClaiming = async (indexes: number[]): Promise<Map<number, StreamPairRow>> => {
    let pairs = latestPairs;
    try {
      pairs = await client.listPairs();
    } catch (err) {
      debug(`listPairs failed before manual pair, using cached subscription state: ${err instanceof Error ? err.message : String(err)}`);
    }
    const claimed = new Map<number, StreamPairRow>();
    for (const index of indexes) {
      const pair = pairs.find((p) => p.frontIndex === index || p.backIndex === index);
      if (pair) claimed.set(index, pair);
    }
    return claimed;
  };

  /**
   * Break whatever is holding the two picks, so the manual pair can be forced.
   * Announces on the first round only — later rounds are the race below losing
   * again, which is debug noise, not news.
   */
  const freeClaimedPicks = async (
    frontIndex: number,
    backIndex: number,
    announce: boolean,
  ): Promise<void> => {
    const claimed = await pairsClaiming([frontIndex, backIndex]);
    const broken = new Set<string>();
    for (const [index, pair] of claimed) {
      const key = pairKey(pair.frontIndex, pair.backIndex);
      // Both picks can sit in the SAME pair — the server already matched these
      // two automatically. Breaking it once and re-forcing it is still worth
      // doing: it comes back as a manual pair, which is sticky.
      if (broken.has(key)) continue;
      broken.add(key);
      if (announce) {
        const other = pair.frontIndex === index ? pair.backIndex : pair.frontIndex;
        await queuedLog(
          chalk.yellow(
            other === (index === frontIndex ? backIndex : frontIndex)
              ? `  #${frontIndex} ↔ #${backIndex} was already paired automatically — re-forcing it so it sticks.`
              : `  #${index} was paired with #${other} while you were choosing — breaking that pair first.`,
          ),
        );
      }
      await client.unpairImages(pair.frontIndex, pair.backIndex);
      unpairLocal(pair.frontIndex, pair.backIndex);
    }
  };

  // Force-pair two waiting cards (idle-menu 'm'). The pair flows back through
  // onPairsUpdate → the normal review handoff, so nothing else is needed here.
  const manualPairAction = async (): Promise<void> => {
    const pool = await listWaitingPool();
    if (pool.length < 2) {
      await queuedLog(chalk.dim('  Need at least two waiting cards to pair by hand.'));
      return;
    }
    await printPoolWithPreviews(pool);
    const frontIndex = await pickCard('Pick the FRONT card', pool);
    if (frontIndex === null) {
      await queuedLog(chalk.dim('  Cancelled.'));
      return;
    }
    const backIndex = await pickCard('Pick the BACK card', pool.filter((r) => r.entryIndex !== frontIndex));
    if (backIndex === null) {
      await queuedLog(chalk.dim('  Cancelled.'));
      return;
    }

    // Clear the picks, then force the pair — retried, because on an ACTIVE job
    // `unpairImages` schedules an automatic re-pair that can re-form the very
    // pair we just broke before our manual one lands. Bounded by the same
    // MAX_RE_UNPAIR as the review-menu separations: a server that keeps
    // insisting is a thing to report, not to fight forever. Once the manual
    // pair exists it is sticky, so the race is over for good.
    let paired = false;
    for (let attempt = 0; attempt < MAX_RE_UNPAIR && !paired; attempt++) {
      await freeClaimedPicks(frontIndex, backIndex, attempt === 0);
      try {
        await client.pairImages(frontIndex, backIndex);
        paired = true;
      } catch (err) {
        // Deliberately NOT a match on the message. The backend rejects this
        // with a plain `throw new Error("image is already paired …")`, and the
        // production deployment we talk to redacts a thrown Error to a bare
        // "Server Error" — the sentence never reaches us (that redaction is
        // why this failure was unreadable in the first place). So don't read
        // the refusal, re-read the STATE: if something is holding a pick, this
        // is the race and the next round breaks it. Anything else is a real
        // failure and belongs on screen.
        const stillClaimed = await pairsClaiming([frontIndex, backIndex]);
        if (stillClaimed.size === 0) throw err;
        debug(`Manual pair #${frontIndex}↔#${backIndex} lost a race with automatic pairing (attempt ${attempt + 1})`);
      }
    }
    if (!paired) {
      await queuedLog(
        chalk.yellow(
          `  Couldn't force #${frontIndex} ↔ #${backIndex}: the server re-paired one of them faster than we could free it. ` +
            `Break that pair with (U), then retry (M).`,
        ),
      );
      return;
    }
    await queuedLog(
      chalk.green(`  Force-paired #${frontIndex} (front) ↔ #${backIndex} (back) — its review will open shortly.`),
    );
  };

  // Break a wrong pair (idle-menu 'u'), freeing both sides to pair again.
  const unpairAction = async (): Promise<void> => {
    let pairs = latestPairs;
    try {
      pairs = await client.listPairs();
    } catch (err) {
      debug(`listPairs failed, using cached subscription state: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (pairs.length === 0) {
      await queuedLog(chalk.dim('  No pairs to break.'));
      return;
    }
    const choice = await ask('Pick a pair to break', undefined, {
      selectOptions: pairs.map((p) => ({
        name: `#${p.frontIndex} ↔ #${p.backIndex} — ${p.player ?? '?'} (${p.confidence}/${p.mechanism})`,
        value: `${p.frontIndex}:${p.backIndex}`,
      })),
    });
    if (choice === undefined || choice === null || choice === '') {
      await queuedLog(chalk.dim('  Cancelled.'));
      return;
    }
    const [frontIndex, backIndex] = String(choice).split(':').map(Number);
    await client.unpairImages(frontIndex, backIndex);
    unpairLocal(frontIndex, backIndex);
    await queuedLog(chalk.green(`  Unpaired #${frontIndex} ↔ #${backIndex} — both are back in the waiting pool.`));
  };

  /**
   * Empty the whole waiting pool (idle-menu 'x'). The legacy watcher's escape
   * hatch for a pool that is all duplicates, rescans or junk: rather than
   * walking it card by card, throw the lot away in one keystroke.
   *
   * Each cleared card is tombstoned the same way a review-time reject is, so
   * the server — which has no idea we discarded anything — can't quietly
   * re-pair it into a review later, and its local scan is marked scanned so a
   * re-run doesn't re-upload work that was deliberately abandoned. Pairs that
   * already matched are untouched: this clears what is WAITING, nothing else.
   */
  const clearPoolAction = async (): Promise<void> => {
    const pool = await listWaitingPool();
    if (pool.length === 0) {
      await queuedLog(chalk.dim('  No cards are waiting for a partner right now.'));
      return;
    }
    // Labels only, no previews: this is the bulk action, and downloading a
    // crop for every card just to throw them all away is the wrong trade.
    await queuedLog(chalk.yellow.bold(`  ${pool.length} card(s) waiting for a partner:`));
    for (const row of pool) await queuedLog(chalk.yellow(`    ${poolLabel(row)}`));
    await queuedLog('');

    const confirmed = await ask(
      `Clear all ${pool.length} waiting card(s) from the pool?`,
      false,
      { isYN: true },
    );
    if (!confirmed) {
      await queuedLog(chalk.dim('  Cancelled — the pool is unchanged.'));
      return;
    }

    for (const row of pool) {
      rejectedEntries.add(row.entryIndex);
      previewCache.delete(row.entryIndex);
      const local = entries.get(row.entryIndex);
      if (local && onSkip) onSkip(local.localPath);
    }
    await queuedLog(
      chalk.yellow(
        `  Cleared ${pool.length} card(s) from the pool and marked them scanned. ` +
          `Rescan anything you still want listed.`,
      ),
    );
  };

  /**
   * Run an idle-menu override action, turning a not-yet-deployed backend
   * mutation into a clear on-screen warning (and leaving the session running)
   * instead of a crash — per the NEO-170 backend contract.
   */
  const runAction = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof MissingBackendFunctionError) {
        await queuedLog(chalk.yellow(`  ${err.message}`));
        await queuedLog(chalk.yellow('  Update the NeonBinder backend, then retry. No changes were made.'));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await queuedLog(chalk.red(`  Action failed: ${message}`));
        // The production Convex deployment redacts a thrown Error's message to
        // a bare "Server Error", so the backend's actual reason — the sentence
        // that would tell you what to do — never crosses the wire. Nothing we
        // can do about that from here (the backend is not ours to change), but
        // saying WHERE the reason went beats leaving "Server Error" to look
        // like the whole explanation.
        if (/\bServer Error\b/.test(message)) {
          await queuedLog(
            chalk.dim('  (the backend redacts its reason on prod — the full message is in the NeonBinder Convex logs)'),
          );
        }
      }
    }
  };

  const readWaitingKey = (
    signal: AbortSignal,
  ): Promise<{ type: 'key'; char: string } | { type: 'abort' } | { type: 'ctrlc' }> => {
    return new Promise((resolve) => {
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
      readline.emitKeypressEvents(stdin);
      const wasRaw = stdin.isRaw ?? false;

      let settled = false;
      const cleanupIO = () => {
        if (settled) return;
        settled = true;
        stdin.removeListener('keypress', onKey);
        signal.removeEventListener('abort', onAbort);
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.pause();
      };

      const onKey = (str: string, key: { name?: string; ctrl?: boolean }) => {
        if (key && key.ctrl && key.name === 'c') {
          cleanupIO();
          resolve({ type: 'ctrlc' });
          return;
        }
        cleanupIO();
        resolve({ type: 'key', char: str ?? '' });
      };
      const onAbort = () => {
        cleanupIO();
        resolve({ type: 'abort' });
      };

      if (signal.aborted) {
        resolve({ type: 'abort' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKey);
    });
  };

  const printIdleMenu = () => {
    const waitingCount = latestImages.filter(isWaiting).length;
    const pairCount = latestPairs.length;
    // eslint-disable-next-line no-console
    const line = (s: string) => console.log(s);

    line('');
    line('  ' + chalk.yellow.bold('(C)') + 'omplete and sync (finish the session)');
    line(
      '  ' + chalk.yellow.bold('(A)') + 'bort — cancel remaining processing' +
      chalk.dim(' (files stay unscanned for a re-run)'),
    );
    if (waitingCount > 0) {
      line('  ' + chalk.yellow.bold('(V)') + 'iew waiting cards with image previews');
      line('  ' + chalk.yellow.bold('(P)') + ' fix a waiting card\'s identity (player/team/#/side), then re-pair');
    }
    if (waitingCount >= 2) {
      line('  ' + chalk.yellow.bold('(M)') + 'anually pair two waiting cards (front + back)');
    }
    if (pairCount > 0) {
      line('  ' + chalk.yellow.bold('(U)') + 'npair a wrong pair (frees both to pair again)');
    }
    if (waitingCount > 0) {
      line(
        '  ' + chalk.yellow.bold('(X)') + ' clear the whole waiting pool' +
        chalk.dim(' (drops every waiting card — duplicates, rescans, junk)'),
      );
    }
    line('');
    line(chalk.dim('  Pairing is automatic and identity-first; V/P/M/U/X are the manual override.'));
    line(chalk.dim('  Press a key, or wait for new files...'));
    line('');
  };

  const completeSession = async () => {
    debug('Completion signal received');
    // Mirror legacy semantics: Complete abandons whatever never paired.
    // Failed and never-paired local files are marked scanned so the next run
    // doesn't re-upload work the user has walked away from.
    for (const [entryIndex, entry] of entries) {
      if (!handedOff.has(entryIndex) && onSkip) onSkip(entry.localPath);
    }
    markSessionComplete();
    const closeSpinner = showSpinner('close-stream', 'Closing NeonBinder scan session');
    await client.closeStream();
    closeSpinner.finish('closed');
    cleanup();
    if (resolveCompletion) resolveCompletion();
  };

  const abortSession = async () => {
    debug('Abort signal received');
    // Unlike Complete: nothing is marked scanned — an aborted batch is meant
    // to be re-run, so every file must be picked up again next time.
    markSessionComplete();
    const spinner = showSpinner('abort-stream', 'Aborting — cancelling remaining processing');
    const stoppedCount = await client.cancelBatch();
    spinner.finish(`${stoppedCount} pending item(s) cancelled`);
    cleanup();
    if (resolveCompletion) resolveCompletion();
  };

  const waitingTaskBody = async (): Promise<void> => {
    if (stopped || isSessionComplete()) return;

    await printWaitingHeader();

    const controller = new AbortController();
    setWaitingAbort(controller);
    printIdleMenu();

    try {
      while (true) {
        const result = await readWaitingKey(controller.signal);
        if (result.type === 'abort') {
          debug('Waiting task aborted (background work arrived)');
          return;
        }
        if (result.type === 'ctrlc') {
          debug('Ctrl-C received in waiting task');
          const confirmExit = await ask('Are you sure you want to exit?', false, { isYN: true });
          if (confirmExit) {
            markCtrlCPressed();
            await client.closeStream();
            cleanup();
            if (resolveCompletion) resolveCompletion();
          }
          return;
        }
        const char = result.char.toLowerCase();
        if (char === 'c') {
          await completeSession();
          return;
        }
        if (char === 'a') {
          const confirmAbort = await ask('Abort and cancel remaining processing?', false, { isYN: true });
          if (confirmAbort) {
            await abortSession();
          }
          return;
        }
        // Manual-override actions. Each runs inline (we own the UI thread here),
        // then returns so the UI loop re-enqueues a fresh waiting task with the
        // header/menu re-rendered from the updated remote state.
        if (char === 'v') {
          await runAction(viewPoolAction);
          return;
        }
        if (char === 'p') {
          await runAction(editIdentityAction);
          return;
        }
        if (char === 'm') {
          await runAction(manualPairAction);
          return;
        }
        if (char === 'u') {
          await runAction(unpairAction);
          return;
        }
        if (char === 'x') {
          await runAction(clearPoolAction);
          return;
        }
        // unknown key — re-read without reprinting the menu
      }
    } finally {
      setWaitingAbort(null);
    }
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  const cleanup = () => {
    stopped = true;
    intakeQueue.end();
    pairQueue.end();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    recentlySeen.clear();
    for (const unsub of unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // best-effort
      }
    }
  };

  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve;

    try {
      watcher = fs.watch(directory, (eventType, filename) => {
        if (!filename) return;
        handleNewFile(path.join(directory, filename));
      });
      watcher.on('error', (err) => {
        debug(`Watcher error: ${err.message}`);
        cleanup();
        resolve();
      });
    } catch (err) {
      debug(`Failed to start watcher: ${err}`);
      resolve();
      return;
    }

    // Reactive subscriptions drive spinners, pair handoff, and the idle header.
    unsubscribers.push(
      client.onJob((job) => {
        latestJob = job;
        maybeRefreshIdle();
      }),
      client.onImages(onImagesUpdate),
      client.onPairs(onPairsUpdate),
    );

    debug('Streaming watch mode active. Directory watcher started.');

    const initialSet = new Set(initialFiles);
    for (const filePath of initialFiles) {
      knownFiles.add(filePath);
      enqueueFile(filePath);
    }

    // Catch files dropped between the caller's snapshot and fs.watch
    // registration (same rescan the legacy watcher does).
    try {
      const dirEntries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.jpg')) continue;
        const filePath = path.join(directory, entry.name);
        if (initialSet.has(filePath)) continue;
        if (knownFiles.has(filePath)) continue;
        if (isAlreadyScanned(filePath)) continue;
        debug(`Catching dropped file at startup: ${entry.name}`);
        knownFiles.add(filePath);
        enqueueFile(filePath);
      }
    } catch (err) {
      debug(`Startup directory rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (intakeQueue.length === 0 && resolveIntakeIdle) {
      resolveIntakeIdle();
      resolveIntakeIdle = null;
    }
  });

  return {
    completionPromise,
    intakeIdlePromise,
    startUILoop: () => {
      setWaitingTaskFactory(waitingTaskBody);
      startUILoop();
    },
    stop: () => {
      void client.closeStream();
      cleanup();
      setWaitingTaskFactory(null);
      if (resolveCompletion) resolveCompletion();
    },
    reAddToPool: async (card: UnmatchedCard) => {
      // The review menu rejected one side of an auto-matched pair. Server-side,
      // the fix is to BREAK that pair: unpairing frees the kept side back into
      // the waiting pool so it re-pairs with a fresh rescan of the rejected
      // side (or a manual pair). Resolve the kept card back to its server entry
      // via the local scan it came from, then unpair the pair it belongs to.
      const keptEntry = resolveEntry(card);
      const pair = keptEntry !== undefined ? pairByEntry.get(keptEntry) : undefined;
      if (!pair) {
        log(
          chalk.yellow(
            `Couldn't map ${path.basename(card.path)} back to a server pair — ` +
              `re-scan BOTH sides to pair it again, or use the idle menu's (M)pair / (U)npair controls.`,
          ),
        );
        return;
      }
      // Tombstone the half the operator threw away BEFORE unpairing. Unpair
      // frees both sides, and the server's next pairing run would otherwise
      // re-form this exact pair and reopen the review we just rejected.
      const rejectedEntry = pair.frontIndex === keptEntry ? pair.backIndex : pair.frontIndex;
      rejectedEntries.add(rejectedEntry);
      try {
        await client.unpairImages(pair.frontIndex, pair.backIndex);
        unpairLocal(pair.frontIndex, pair.backIndex);
        log(
          chalk.yellow(
            `Unpaired #${pair.frontIndex}↔#${pair.backIndex} — dropped #${rejectedEntry}, ` +
              `${card.side} #${keptEntry} is back in the waiting pool. Rescan the rejected side.`,
          ),
        );
      } catch (err) {
        if (err instanceof MissingBackendFunctionError) {
          log(
            chalk.yellow(
              `Server-side unpair isn't available yet (${err.message}) — re-scan BOTH sides to pair again.`,
            ),
          );
        } else {
          log(chalk.red(`Unpair failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    },
    unpairInReview: async (front: UnmatchedCard, back: UnmatchedCard) => {
      // Review-menu (U): the two scans are different cards. Both images are
      // good, so neither is tombstoned — only this pairing is banned, and both
      // sides go back to the waiting pool to find their real partners.
      const frontEntry = resolveEntry(front);
      const backEntry = resolveEntry(back);
      const pair =
        (frontEntry !== undefined ? pairByEntry.get(frontEntry) : undefined) ??
        (backEntry !== undefined ? pairByEntry.get(backEntry) : undefined);
      if (!pair) {
        log(
          chalk.yellow(
            `Couldn't map ${path.basename(front.path)} / ${path.basename(back.path)} back to a server pair — ` +
              `use the idle menu's (U)npair to separate them.`,
          ),
        );
        return;
      }
      // Ban BEFORE unpairing: unpair frees both sides and the server's next
      // pairing run would otherwise re-form this exact pair immediately.
      bannedPairs.add(pairKey(pair.frontIndex, pair.backIndex));
      try {
        await client.unpairImages(pair.frontIndex, pair.backIndex);
        unpairLocal(pair.frontIndex, pair.backIndex);
        log(
          chalk.yellow(
            `Unpaired #${pair.frontIndex}↔#${pair.backIndex} — both sides are back in the waiting pool ` +
              `and will not be paired with each other again.`,
          ),
        );
      } catch (err) {
        if (err instanceof MissingBackendFunctionError) {
          log(
            chalk.yellow(
              `Server-side unpair isn't available yet (${err.message}) — the pairing is blocked locally, ` +
                `but re-scan both sides to pair them correctly.`,
            ),
          );
        } else {
          log(chalk.red(`Unpair failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    },
  };
}

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
 * server-side, and a client-side mirror would drift. That also means the idle
 * menu's pool-fix options don't exist in this mode — unpaired cards show as
 * live remote state instead.
 */
import fs from 'fs';
import path from 'path';
import readline from 'node:readline';
import Queue from 'queue';
import { useSpinners } from './spinners.js';
import chalk from 'chalk';
import type { CardSide, MatchResult, UnmatchedCard } from './cardPool.js';
import { ask, queuedLog } from './ask.js';
import { createLogger } from './logger.js';
import { terminalLink } from './terminalLink.js';
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
  // Pair keys already seen and entry indexes already handed to review — a
  // server-side pair revision that would re-review a physical scan is skipped.
  const seenPairs = new Set<string>();
  const handedOff = new Set<number>();
  let lastIdleRenderKey = '';
  const unsubscribers: (() => void)[] = [];

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
    const key = `${pair.frontIndex}-${pair.backIndex}`;
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
    for (const pair of rows) {
      // Deduped at ENQUEUE time so a burst of subscription updates cannot
      // queue the same pair twice before its first task runs.
      const key = `${pair.frontIndex}-${pair.backIndex}`;
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
    const unpaired = latestImages.filter(
      (r) => r.status === 'done' && !handedOff.has(r.entryIndex),
    );
    if (unpaired.length > 0) {
      await queuedLog(chalk.yellow(`  ${unpaired.length} card(s) waiting for a partner:`));
      for (const row of unpaired) {
        const local = entries.get(row.entryIndex);
        await queuedLog(
          chalk.yellow(`    ${local?.basename ?? row.originalName}: ${describeRow(row)}`),
        );
      }
    }
    await queuedLog('');
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
     
    console.log('');
     
    console.log('  ' + chalk.yellow.bold('(C)') + 'omplete and sync (finish the session)');
     
    console.log('');
     
    console.log(chalk.dim('  Press a key, or wait for new files...'));
     
    console.log('');
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
        if (result.char.toLowerCase() === 'c') {
          await completeSession();
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
      // No server-side un-pair exists (yet): the rejected pair keeps its
      // server rows, so the kept side cannot re-enter matching this session.
      // Rescanning BOTH sides as fresh files creates a brand-new pair.
      // TODO(NEO-170 follow-up): server-side re-pair for a rejected side.
      log(
        chalk.yellow(
          `Streaming mode can't return ${path.basename(card.path)} to the pool — ` +
            `re-scan BOTH sides of this card to pair it again.`,
        ),
      );
    },
  };
}

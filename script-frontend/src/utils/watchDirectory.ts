import fs from 'fs';
import path from 'path';
import readline from 'node:readline';
import Queue from 'queue';
import { useSpinners } from './spinners.js';
import chalk from 'chalk';
import { CardPool, type CardSide, type MatchResult, type UnmatchedCard, type OcrTextResolver } from './cardPool.js';
import { ask, queuedLog } from './ask.js';
import { createLogger } from './logger.js';
import {
  setWaitingTaskFactory,
  setWaitingAbort,
  abortWaitingTask,
  markSessionComplete,
  isSessionComplete,
  markCtrlCPressed,
  startUILoop,
} from './uiQueue.js';

const { showSpinner } = useSpinners('watch', chalk.magenta);
const debug = createLogger('watch');

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
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

export interface DirectoryWatcher {
  /** Resolves when the user picks Complete (or Ctrl-C) from the waiting task. */
  completionPromise: Promise<void>;
  /** Resolves when the intake queue first becomes idle after processing initial files */
  intakeIdlePromise: Promise<void>;
  /**
   * Register this watcher's waiting-task body with the UI queue and push the
   * first iteration. Call once after initial-file processing completes.
   */
  startUILoop: () => void;
  /** Stop watching immediately (for error cases) */
  stop: () => void;
  /**
   * Re-add a previously-matched card back into the pool. Used when the user
   * rejects one side of a pair in the review menu — the kept side returns to
   * the pool so it can match against a fresh rescan of the rejected side.
   */
  reAddToPool: (card: UnmatchedCard) => Promise<void>;
}

// ── Smart matching watcher ─────────────────────────────────────────────────

/** Result of the automated intake phase for a single card image. */
export interface IntakeResult {
  originalPath: string;
  croppedPath: string | null;
  card: UnmatchedCard;
}

export interface SmartWatcherOptions {
  directory: string;
  knownFiles: Set<string>;
  /**
   * Map of already-scanned filenames to the mtimeMs recorded when they were
   * scanned. A value of 0 is a legacy entry (filename only) and is treated as
   * "always skip". Files on disk whose mtime is newer than the recorded value
   * are treated as new (the user dropped a replacement with the same name).
   */
  scannedFiles?: Map<string, number>;
  /** Files already present in the directory to process through the smart flow */
  initialFiles?: string[];

  // ── Automated callbacks (intake queue, concurrency 3) ───────────────────
  /** Automated crop — no user prompts. Returns cropped path or null on failure. */
  autoCrop?: (imagePath: string) => Promise<string | null>;
  /** Automated orientation fix — runs after successful crop. Returns text detection count. */
  autoOrient?: (imagePath: string) => Promise<number>;
  /**
   * Classify and extract info from a single image (vision AI). `imagePath` is the
   * best candidate the pipeline has so far (cropped if autoCrop succeeded, else the
   * original). `originalPath` is the raw input file, passed separately so remote
   * callers can POST both the original and the precropped candidate to `/process`.
   */
  classifyAndExtract: (
    imagePath: string,
    textDetectionCount: number,
    originalPath: string,
  ) => Promise<UnmatchedCard>;

  // ── Confirmation callbacks (intake queue — auto-accept in watch mode) ────
  /** Confirm crop result. Return confirmed path (may re-crop interactively). */
  confirmCrop: (originalPath: string, croppedPath: string | null) => Promise<string>;
  /** Show image, let user rotate. Modifies file in-place. */
  confirmRotation: (imagePath: string) => Promise<void>;
  /** Show detected player name, let user correct. Returns confirmed name. */
  confirmPlayer: (imagePath: string, detectedPlayer: string | null) => Promise<string | null>;
  /** Prompt user to confirm or flip the detected side. Return 'skip' to stop processing. */
  confirmSide: (imagePath: string, detectedSide: CardSide, card: UnmatchedCard) => Promise<CardSide | 'skip'>;

  /** Called when the user skips a card — receives the cropped image path */
  onSkip?: (imagePath: string) => void;
  /** OCR text resolver for fallback pool matching when vision AI extraction misses names */
  ocrResolver?: OcrTextResolver;
  /** Render a small image preview and return it as a string (for pool card display in idle prompt). */
  renderCardPreview?: (imagePath: string) => Promise<string | void>;
  /** Interactively resolve unmatched pool cards — prompt user for player name + side corrections.
   *  Receives current pool cards, returns updated cards. */
  onResolvePool?: (cards: UnmatchedCard[]) => Promise<UnmatchedCard[]>;
  /** Called when a front/back pair is matched — includes pool extraction data as priors */
  onPairReady: (front: string, back: string, match: MatchResult) => Promise<void>;
}

export function watchWithSmartMatching(opts: SmartWatcherOptions): DirectoryWatcher {
  const {
    directory,
    knownFiles,
    scannedFiles,
    initialFiles = [],
    autoCrop,
    autoOrient,
    classifyAndExtract,
    confirmCrop,
    confirmRotation,
    confirmPlayer,
    confirmSide,
    onSkip,
    ocrResolver,
    renderCardPreview,
    onResolvePool,
    onPairReady,
  } = opts;

  const pool = new CardPool(ocrResolver);
  const recentlySeen = new Map<string, number>();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let resolveCompletion: (() => void) | null = null;

  // ── Single intake queue ──────────────────────────────────────────────────
  // Intake queue: automated work — crop, orient, classify, auto-confirm, and
  // pool matching. Matched pairs are handed off to onPairReady which pushes
  // into the card processor queue in listSet.ts.
  //
  // Concurrency is env-tunable via INTAKE_CONCURRENCY (default 10). The
  // practical bottleneck is upload bandwidth for the 22 MB original JPEGs, not
  // server-side compute — at ~10 in-flight uploads the preprocess service can
  // turn requests around faster than we can ship bytes, so going higher just
  // queues bytes on the wire and risks per-request timeouts.
  const intakeConcurrency = Math.max(1, Number(process.env.INTAKE_CONCURRENCY) || 10);
  const intakeQueue = new Queue({ autostart: true, concurrency: intakeConcurrency, results: [] });

  // Pool lock: serializes addCard + handleMatchedPair so concurrent intake
  // jobs don't race on pool access (crop/orient/classify still run in parallel).
  let poolLock = Promise.resolve();

  // Resolves when intake queue first becomes idle after initial files are processed
  let resolveIntakeIdle: (() => void) | null = null;
  const intakeIdlePromise = new Promise<void>((resolve) => {
    resolveIntakeIdle = resolve;
  });

  intakeQueue.addEventListener('end', () => {
    if (resolveIntakeIdle) {
      resolveIntakeIdle();
      resolveIntakeIdle = null;
    }
    // When the intake queue drains after processing new files, abort the
    // current waiting task so it re-renders with updated pool contents.
    // Without this, the idle screen stays stale (showing old pool state)
    // when cards enter the pool without matching a pair.
    abortWaitingTask();
  });

  /**
   * Called from inside the intake queue's pool-lock section when a pair matches.
   * Must stay synchronous and fire-and-forget — we're holding poolLock and cannot
   * await anything that might touch the UI queue. The actual handoff to the UI
   * thread happens later, inside listSet.ts's onPairReady after buildCardState
   * finishes, which is outside this lock.
   */
  const handleMatchedPair = (match: MatchResult) => {
    onPairReady(match.front.path, match.back.path, match).catch((err) => {
      debug(`onPairReady failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  /**
   * Re-add a card to the pool after the user rejected its partner in review.
   * Runs under the pool lock like normal intake so concurrent drops can't
   * race. If a waiting opposite-side card is already in the pool (rare but
   * possible), we immediately hand off the new match.
   */
  const reAddToPool = async (card: UnmatchedCard): Promise<void> => {
    let releaseLock!: () => void;
    const prev = poolLock;
    poolLock = new Promise<void>((res) => { releaseLock = res; });
    await prev;
    try {
      card.timestamp = Date.now();
      const match = await pool.addCard(card);
      if (match) {
        debug(`Re-added card immediately re-matched: ${match.front.player ?? path.basename(match.front.path)} ↔ ${match.back.player ?? path.basename(match.back.path)}`);
        handleMatchedPair(match);
      } else {
        debug(`Re-added ${path.basename(card.path)} to pool, waiting for ${card.side === 'front' ? 'back' : 'front'}`);
      }
    } finally {
      releaseLock();
    }
  };

  const enqueueFile = (filePath: string) => {
    // Safety net: skip files already in scanned.txt (covers initialFiles too)
    if (isAlreadyScanned(filePath)) {
      debug(`Skipping already-scanned file: ${path.basename(filePath)}`);
      return;
    }

    // When a pair matches, onPairReady → submitUITask('review') aborts the
    // waiting task. For no-match cases, the intake queue 'end' event aborts
    // it so the idle screen re-renders with updated pool contents.

    // Intake queue: all automated work runs in parallel up to INTAKE_CONCURRENCY.
    intakeQueue.push(async () => {
      if (stopped) return;
      const basename = path.basename(filePath);
      const { update, finish, error } = showSpinner(`intake-${basename}`, `Processing ${basename}`);

      // Step 1: Automated crop (no user prompts)
      let croppedPath: string | null = null;
      if (autoCrop) {
        try {
          update(`Cropping`);
          croppedPath = await autoCrop(filePath);
          if (!croppedPath) {
            debug(`Crop failed for ${basename}, will prompt in review`);
            update(`Crop failed, will prompt in review`);
          }
        } catch (err) {
          debug(`Crop error for ${basename}: ${err}`);
          update(`Crop error, will prompt in review`);
        }
      }

      // Step 2: Automated orientation fix (only if crop succeeded)
      let textDetectionCount = 0;
      if (croppedPath && autoOrient) {
        try {
          update(`Orienting`);
          textDetectionCount = await autoOrient(croppedPath);
        } catch (err) {
          // best-effort, don't block
        }
      }

      // Step 3: Classify & extract via vision AI
      const pathForClassification = croppedPath ?? filePath;
      // Remember the pre-crop path so the review menu can re-crop from the
      // original instead of re-cropping the already-tightened intake output.
      const originalPath = croppedPath && croppedPath !== filePath ? filePath : undefined;
      let card: UnmatchedCard;
      try {
        update(`Classifying`);
        card = await classifyAndExtract(pathForClassification, textDetectionCount, filePath);
        if (stopped) return;
        if (originalPath) card.originalPath = originalPath;
      } catch (err) {
        debug(`Classification failed for ${basename}: ${err}`);
        // Don't silently drop — create a minimal card for pool/manual resolution
        card = {
          path: croppedPath ?? filePath,
          side: textDetectionCount >= 5 ? 'back' : 'front',
          player: null,
          team: null,
          cardNumber: null,
          textDetectionCount,
          timestamp: Date.now(),
          originalFilename: basename,
          originalPath,
        };
        update(`Classification failed, added to pool for manual resolve`);
      }

      const detected = card.side +
        (card.player ? ` — ${card.player}` : '') +
        (card.team ? ` (${card.team})` : '');

      debug(`Classified ${basename}: ${detected}`);

      if (stopped) { finish(detected); return; }

      // Auto-confirm crop/rotation/player/side (all no-ops in watch mode)
      const confirmedPath = await confirmCrop(filePath, croppedPath);
      croppedPath = confirmedPath;
      card.path = confirmedPath;
      card.originalFilename = basename;

      if (croppedPath !== filePath) {
        await confirmRotation(croppedPath);
      }

      if (stopped) { finish(detected); return; }

      const confirmedPlayer = await confirmPlayer(croppedPath, card.player);
      if (confirmedPlayer !== card.player) {
        debug(`Player name updated: ${card.player ?? '(none)'} → ${confirmedPlayer ?? '(none)'}`);
        card.player = confirmedPlayer;
      }

      if (stopped) { finish(detected); return; }

      const confirmedSide = await confirmSide(croppedPath, card.side, card);
      if (confirmedSide === 'skip') {
        debug(`Skipped: ${path.basename(croppedPath)}`);
        if (onSkip) onSkip(croppedPath);
        finish();
        return;
      }
      if (confirmedSide !== card.side) {
        debug(`Side overridden: ${card.side} → ${confirmedSide}`);
        card.side = confirmedSide;
      }

      if (stopped) { finish(detected); return; }

      // Pool matching — serialized via lock so concurrent intake jobs
      // don't race (e.g., two cards from the same drop missing each other).
      let releaseLock!: () => void;
      const prev = poolLock;
      poolLock = new Promise(r => { releaseLock = r; });
      await prev;

      try {
        // Note: pool.addCard now evicts any stale same-side scan internally
        // so a freshly-dropped image always replaces an older one.
        const match = await pool.addCard(card);

        if (match) {
          debug(`Pair matched (${match.confidence}): ${match.front.player ?? path.basename(match.front.path)} ↔ ${match.back.player ?? path.basename(match.back.path)}`);
          finish();
          handleMatchedPair(match);
        } else {
          debug(`${basename} in pool, waiting for ${card.side === 'front' ? 'back' : 'front'}`);
          finish();
        }
      } finally {
        releaseLock();
      }
    });
  };

  /**
   * Check if `filePath` is already recorded in scanned.txt AND the file on
   * disk hasn't been rewritten since. A recorded mtime of 0 is a legacy
   * entry with no mtime — treat as always-scanned for backward compat.
   */
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

  const handleNewFile = (filePath: string) => {
    if (stopped) return;
    if (knownFiles.has(filePath)) return;
    if (!filePath.toLowerCase().endsWith('.jpg')) return;
    // Skip files in subdirectories (e.g. crop/) — only process top-level scan files
    if (path.resolve(path.dirname(filePath)) !== path.resolve(directory)) {
      knownFiles.add(filePath);
      return;
    }
    if (isAlreadyScanned(filePath)) {
      debug(`Skipping already-scanned file: ${path.basename(filePath)}`);
      knownFiles.add(filePath);
      return;
    }

    // Debounce: FSEvents can fire multiple times for the same file
    const now = Date.now();
    const lastSeen = recentlySeen.get(filePath);
    if (lastSeen && now - lastSeen < 500) return;
    recentlySeen.set(filePath, now);

    // Prune entries older than 60s so long sessions don't accumulate stale keys
    if (recentlySeen.size > 200) {
      const cutoff = now - 60_000;
      for (const [key, ts] of recentlySeen) {
        if (ts < cutoff) recentlySeen.delete(key);
      }
    }

    // Wait for file write to complete (poll size until stable)
    void (async () => {
      const stable = await waitForFileStable(filePath);
      if (stopped || !stable) return;

      knownFiles.add(filePath);
      debug(`New file detected: ${path.basename(filePath)}`);
      enqueueFile(filePath);
    })();
  };


  const printWaitingHeader = async () => {
    await queuedLog('');
    await queuedLog(chalk.green.bold('All cards processed. Waiting for new cards...'));
    await queuedLog(chalk.green('  Add .jpg files to the input directory to continue processing.'));
    if (pool.size > 0) {
      await queuedLog(chalk.yellow(`  ${pool.size} unmatched card(s) in pool, waiting for partners:`));
      for (const card of pool.entries()) {
        await queuedLog('');
        if (renderCardPreview) {
          try {
            const preview = await renderCardPreview(card.path);
            if (preview) await queuedLog(preview);
          } catch { /* best-effort */ }
        }
        const displayName = card.originalFilename && card.originalFilename !== path.basename(card.path)
          ? `${path.basename(card.path)} ${chalk.dim(`(${card.originalFilename})`)}`
          : path.basename(card.path);
        await queuedLog(chalk.yellow(`    ${displayName}: ${chalk.bold(card.side)}, ${card.player ?? chalk.red('unknown player')}, #${card.cardNumber ?? '?'}`));
      }
    }
    await queuedLog('');
  };

  const cleanup = () => {
    stopped = true;
    intakeQueue.end();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    recentlySeen.clear();

    // Report remaining unmatched cards
    const remaining = pool.getAll();
    if (remaining.length > 0) {
      debug(`${remaining.length} unmatched card(s) remaining`);
      for (const card of remaining) {
        debug(`  - ${path.basename(card.path)} (${card.side}, ${card.player ?? 'unknown'})`);
      }
    }
  };

  const resolvePoolManually = async () => {
    if (!onResolvePool || pool.size === 0) return;

    try {
      const cards = pool.getAll();
      const updatedCards = await onResolvePool(cards);

      // Clear all cards from the pool and re-add with updated info
      for (const card of cards) {
        pool.remove(card.path);
      }

      // Re-add updated cards — pool matching will try to pair them
      for (const card of updatedCards) {
        const match = await pool.addCard(card);
        if (match) {
          debug(`Manual resolve matched: ${match.front.player ?? path.basename(match.front.path)} ↔ ${match.back.player ?? path.basename(match.back.path)}`);
          handleMatchedPair(match);
        }
      }

      if (pool.size > 0) {
        debug(`${pool.size} card(s) still unmatched after manual resolve`);
      }
    } catch (err) {
      debug(`Pool resolve error: ${err}`);
    }
  };

  const clearPoolAll = () => {
    const cards = pool.getAll();
    if (cards.length === 0) return;

    const scannedTxtPath = path.join(directory, 'scanned.txt');
    for (const card of cards) {
      pool.remove(card.path);
      const originalName = card.originalFilename ?? path.basename(card.path);
      if (scannedFiles && !scannedFiles.has(originalName)) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(directory, originalName)).mtimeMs;
        } catch { /* original already gone — record 0 (always skip) */ }
        scannedFiles.set(originalName, mtimeMs);
        fs.appendFileSync(scannedTxtPath, `${originalName}\t${mtimeMs}\n`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`Cleared ${cards.length} card(s) from pool and marked as scanned.`));
    debug(`Cleared all ${cards.length} card(s) from pool`);
  };

  const removeFromPoolInteractive = async () => {
    if (pool.size === 0) return;

    const scannedTxtPath = path.join(directory, 'scanned.txt');
    const cards = pool.getAll();

    for (const card of cards) {
      // We're inside a UI task — direct console writes are safe (we own the thread).
      if (renderCardPreview) {
        try {
          const preview = await renderCardPreview(card.path);
          // eslint-disable-next-line no-console
          if (preview) console.log(preview);
        } catch { /* best-effort */ }
      }
      const displayName = card.originalFilename ?? path.basename(card.path);
      const playerInfo = card.player ?? 'unknown player';
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(`  ${displayName}: ${chalk.bold(card.side)}, ${playerInfo}, #${card.cardNumber ?? '?'}`));

      const shouldRemove = await ask(`Remove this card from the pool?`, false, { isYN: true });
      if (shouldRemove) {
        pool.remove(card.path);
        // Mark original filename as scanned so it won't be picked up again.
        // Record the original file's current mtime so that a later replacement
        // with the same name (but newer mtime) is treated as a new file.
        const originalName = card.originalFilename ?? path.basename(card.path);
        if (scannedFiles && !scannedFiles.has(originalName)) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(path.join(directory, originalName)).mtimeMs;
          } catch { /* original already gone — record 0 (always skip) */ }
          scannedFiles.set(originalName, mtimeMs);
          fs.appendFileSync(scannedTxtPath, `${originalName}\t${mtimeMs}\n`);
        }
        debug(`Removed from pool and marked as scanned: ${originalName}`);
      }
    }
  };

  type IdleAction = 'complete' | 'resolve' | 'remove' | 'clear';

  type IdleKeyChoice = { key: string; label: string; value: IdleAction };

  /**
   * Read a single keystroke from stdin in raw mode, racing against an
   * AbortSignal. Returns:
   *   { type: 'key', char } — user pressed a key
   *   { type: 'abort' }      — signal fired (e.g., new work arrived)
   *   { type: 'ctrlc' }      — Ctrl-C
   * Always restores cooked mode and removes listeners before resolving.
   */
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

  const printIdleMenu = (choices: IdleKeyChoice[]) => {
    // eslint-disable-next-line no-console
    console.log('');
    for (const c of choices) {
      const i = c.label.toLowerCase().indexOf(c.key.toLowerCase());
      let rendered: string;
      if (i >= 0) {
        rendered =
          c.label.slice(0, i) +
          chalk.yellow.bold('(' + c.label[i] + ')') +
          c.label.slice(i + 1);
      } else {
        rendered = chalk.yellow.bold('(' + c.key.toUpperCase() + ')') + ' ' + c.label;
      }
      // eslint-disable-next-line no-console
      console.log('  ' + rendered);
    }
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(chalk.dim('  Press a key, or wait for new files...'));
    // eslint-disable-next-line no-console
    console.log('');
  };

  /**
   * Body of a single waiting-task iteration. Registered with the UI queue via
   * setWaitingTaskFactory; the uiQueue coordinator re-enqueues this whenever
   * the queue drains and the session isn't complete.
   *
   * Runs inside a UI task slot — holds the UI thread for its entire body,
   * including any pool walk the user chooses. That means pool resolve/remove
   * are non-interruptible: a newly matched pair's review task waits behind us.
   */
  const waitingTaskBody = async (): Promise<void> => {
    if (stopped || isSessionComplete()) return;

    await printWaitingHeader();

    const choices: IdleKeyChoice[] = [
      { key: 'c', label: 'Complete and sync (finish the session)', value: 'complete' },
      ...(onResolvePool && pool.size > 0
        ? [{ key: 'p', label: 'Fix unmatched pool cards (update player/side)', value: 'resolve' as const }]
        : []),
      ...(pool.size > 0
        ? [{ key: 'r', label: 'Remove cards from the pool', value: 'remove' as const }]
        : []),
      ...(pool.size > 0
        ? [{ key: 'x', label: 'Clear all cards from the pool', value: 'clear' as const }]
        : []),
    ];

    const controller = new AbortController();
    setWaitingAbort(controller);

    printIdleMenu(choices);

    let action: IdleAction | null = null;
    try {
      // Loop until the user presses a recognized key, the signal aborts, or
      // Ctrl-C fires. Unrecognized keys are silently ignored.
      while (action === null) {
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
            cleanup();
            if (resolveCompletion) resolveCompletion();
          }
          return;
        }
        const match = choices.find((c) => c.key === result.char.toLowerCase());
        if (match) action = match.value;
        // else: unknown key — re-read without reprinting the menu
      }
    } finally {
      setWaitingAbort(null);
    }

    if (action === 'complete') {
      debug('Completion signal received');
      const remaining = pool.getAll();
      if (remaining.length > 0) {
        debug(`${remaining.length} unmatched card(s) remaining, marking as scanned`);
        for (const card of remaining) {
          if (onSkip) onSkip(card.path);
        }
      }
      markSessionComplete();
      cleanup();
      if (resolveCompletion) resolveCompletion();
      return;
    }

    // Nested action runs inline inside the same UI task body — non-interruptible
    // by construction. A newly matched pair's review task queues behind us.
    try {
      if (action === 'resolve') {
        await resolvePoolManually();
      } else if (action === 'remove') {
        await removeFromPoolInteractive();
      } else if (action === 'clear') {
        clearPoolAll();
      }
    } catch (err) {
      debug(`Pool action error: ${err}`);
    }
  };

  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve;

    try {
      watcher = fs.watch(directory, (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(directory, filename);
        handleNewFile(filePath);
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

    debug('Smart watch mode active. Directory watcher started.');

    // Enqueue initial files — up to INTAKE_CONCURRENCY will process in parallel
    const initialSet = new Set(initialFiles);
    for (const filePath of initialFiles) {
      knownFiles.add(filePath);
      enqueueFile(filePath);
    }

    // Catch files dropped between the caller's directory snapshot and fs.watch
    // registration. fs.watch only fires for events after it's registered, and
    // initialFiles may be stale (e.g. minutes-old getFiles() result from before
    // slow Medusa setup). Rescan now — safe because fs.watch is already live,
    // so anything landing after this readdir still triggers handleNewFile.
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
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

    // If nothing was actually enqueued (all already scanned), resolve intake idle immediately
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
      cleanup();
      setWaitingTaskFactory(null);
      if (resolveCompletion) resolveCompletion();
    },
    reAddToPool,
  };
}

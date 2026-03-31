import fs from 'fs';
import path from 'path';
import { useSpinners } from './spinners.js';
import chalk from 'chalk';

const { log } = useSpinners('watch', chalk.magenta);

export interface DirectoryWatcher {
  /** Resolves when user types 'c' + Enter and all pairs have been dispatched */
  completionPromise: Promise<void>;
  /** Call this when queues are idle to start listening for the 'c' completion key */
  startListeningForComplete: () => void;
  /** Stop watching immediately (for error cases) */
  stop: () => void;
}

export function watchForNewPairs(
  directory: string,
  knownFiles: Set<string>,
  onPairReady: (imgA: string, imgB: string) => Promise<void>,
  scannedFiles?: Set<string>,
): DirectoryWatcher {
  const pendingFiles: string[] = [];
  const recentlySeen = new Map<string, number>();
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let stdinListener: ((data: Buffer) => void) | null = null;
  let resolveCompletion: (() => void) | null = null;
  let listeningForComplete = false;

  const dispatchPairs = () => {
    while (pendingFiles.length >= 2) {
      const a = pendingFiles.shift()!;
      const b = pendingFiles.shift()!;
      log(`Pairing: ${path.basename(a)} + ${path.basename(b)}`);
      // When a new pair is dispatched, we're no longer idle
      if (listeningForComplete) {
        stopListening();
      }
      // Process the pair, then re-show the idle prompt when done
      onPairReady(a, b).then(() => {
        if (!stopped && !listeningForComplete) {
          startListeningForComplete();
        }
      }).catch(() => {
        // Error handling is done in the queue; re-show prompt regardless
        if (!stopped && !listeningForComplete) {
          startListeningForComplete();
        }
      });
    }
  };

  const handleNewFile = (filePath: string) => {
    if (stopped) return;
    if (knownFiles.has(filePath)) return;
    if (!filePath.toLowerCase().endsWith('.jpg')) return;
    if (scannedFiles?.has(path.basename(filePath))) {
      log(`Skipping already-scanned file: ${path.basename(filePath)}`);
      knownFiles.add(filePath);
      return;
    }

    // Debounce: FSEvents can fire multiple times for the same file
    const now = Date.now();
    const lastSeen = recentlySeen.get(filePath);
    if (lastSeen && now - lastSeen < 500) return;
    recentlySeen.set(filePath, now);

    // Wait briefly for the file write to complete, then verify it exists
    setTimeout(() => {
      if (stopped) return;
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        return; // File disappeared or isn't readable yet
      }

      knownFiles.add(filePath);
      pendingFiles.push(filePath);
      log(`New file detected: ${path.basename(filePath)}`);

      if (pendingFiles.length >= 2) {
        dispatchPairs();
      } else {
        log(`Waiting for pair partner... (${pendingFiles.length} file pending)`);
      }
    }, 300);
  };

  const showWaitingPrompt = () => {
    log('');
    log(chalk.green.bold('All cards processed. Waiting for new cards...'));
    log(chalk.green('  Add .jpg files to the input directory to continue processing.'));
    log(chalk.green('  Type "c" + Enter when finished to complete and sync.'));
    log('');
  };

  const stopListening = () => {
    listeningForComplete = false;
    if (stdinListener) {
      process.stdin.removeListener('data', stdinListener);
      stdinListener = null;
    }
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      // ignore
    }
  };

  const cleanup = () => {
    stopped = true;
    stopListening();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    recentlySeen.clear();
  };

  const startListeningForComplete = () => {
    if (stopped || listeningForComplete) return;
    listeningForComplete = true;
    showWaitingPrompt();

    // Use raw mode so we can detect 'c' character by character
    // but accumulate into a line buffer for 'c' + Enter
    let inputBuffer = '';

    stdinListener = (data: Buffer) => {
      const str = data.toString();

      for (const char of str) {
        // Ctrl+C — exit
        if (char === '\u0003') {
          cleanup();
          process.exit(130);
        }

        // Enter key
        if (char === '\r' || char === '\n') {
          const trimmed = inputBuffer.trim().toLowerCase();
          if (trimmed === 'c') {
            log(chalk.yellow('Completion signal received.'));
            if (pendingFiles.length > 0) {
              log(chalk.yellow(`Warning: ${pendingFiles.length} unpaired file(s) remaining, skipping.`));
            }
            cleanup();
            if (resolveCompletion) resolveCompletion();
            return;
          }
          inputBuffer = '';
        } else {
          inputBuffer += char;
        }
      }
    };

    process.stdin.resume();
    process.stdin.on('data', stdinListener);
  };

  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve;

    // Start watching the directory
    try {
      watcher = fs.watch(directory, (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(directory, filename);
        handleNewFile(filePath);
      });

      watcher.on('error', (err) => {
        log(chalk.red(`Watcher error: ${err.message}`));
        cleanup();
        resolve();
      });
    } catch (err) {
      log(chalk.red(`Failed to start watcher: ${err}`));
      resolve();
      return;
    }

    log(chalk.cyan('Watch mode active. Directory watcher started.'));
  });

  return {
    completionPromise,
    startListeningForComplete,
    stop: () => {
      cleanup();
      if (resolveCompletion) resolveCompletion();
    },
  };
}

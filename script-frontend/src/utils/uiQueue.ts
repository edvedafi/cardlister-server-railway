/**
 * UI Thread queue — the single source of truth for all interactive I/O.
 *
 * Architecture: think of this as the UI thread of a GUI application.
 *   - Exactly ONE interactive task (prompt, log, review menu, pool walk) runs
 *     at a time.
 *   - Background workers (intake, cardProcessor, upload) never touch stdout
 *     directly. They submit UI tasks via `submitUITask(...)`.
 *   - `ask()` and `queuedLog()` in ask.ts route through this queue so that
 *     no prompt can ever be alive concurrently with another prompt or log line.
 *   - When the user is idling on the "waiting" menu, `submitUITask` aborts
 *     the waiting task's rawlist so the newly submitted work runs next.
 *
 * Reentrancy: a UI task's body runs with `uiTaskActive = true`. `ask()` and
 * `queuedLog()` check that flag — if true, they run inline (no re-enqueue),
 * which is safe because we already own the UI thread. Detached promises
 * that outlive the task see `uiTaskActive = false` and correctly submit a
 * new UI task — no AsyncLocalStorage state leak.
 */

import Queue from 'queue';
import chalk from 'chalk';

export type UITaskType = 'waiting' | 'review' | 'log' | 'system';

const uiQueue = new Queue({ autostart: true, concurrency: 1 });

// The `queue` package installs a default 'error' handler that calls this.end()
// on any unhandled task rejection — wiping the entire queue. We replace it
// with a benign logger; task bodies are also individually try/caught below so
// the event should never fire in practice.
uiQueue.removeEventListener('error', (uiQueue as unknown as { _errorHandler: EventListener })._errorHandler);
uiQueue.addEventListener('error', (evt: Event) => {
  const detail = (evt as unknown as { detail?: { error?: unknown } }).detail;
  // eslint-disable-next-line no-console
  console.error(chalk.red('UI queue unexpected error (should be unreachable):'), detail?.error);
});

/**
 * TRUE while a UI task's body is executing. Read by ask()/queuedLog() to
 * decide whether to run inline (we already own the UI thread) or submit a
 * new task. Exported as a getter because module-scoped let is not directly
 * exportable in TS without a function wrapper.
 */
let _uiTaskActive = false;
export const uiTaskActive = (): boolean => _uiTaskActive;

/** Aborts the currently-idling waiting task's rawlist, if any. */
let currentWaitingAbort: AbortController | null = null;
export const setWaitingAbort = (c: AbortController | null): void => {
  currentWaitingAbort = c;
};
/** Abort the current waiting task so it re-enqueues with fresh state. */
export const abortWaitingTask = (): void => {
  if (currentWaitingAbort) {
    try { currentWaitingAbort.abort(); } catch { /* already aborted */ }
  }
};

/** Session lifecycle flags. */
let _sessionComplete = false;
let _ctrlCPressed = false;
export const markSessionComplete = (): void => {
  _sessionComplete = true;
};
export const isSessionComplete = (): boolean => _sessionComplete;
export const markCtrlCPressed = (): void => {
  _ctrlCPressed = true;
  _sessionComplete = true;
};
export const wasCtrlCPressed = (): boolean => _ctrlCPressed;

/** The factory that produces a fresh waiting task, or null if none registered. */
let waitingTaskFactory: (() => Promise<void>) | null = null;
export const setWaitingTaskFactory = (factory: (() => Promise<void>) | null): void => {
  waitingTaskFactory = factory;
};

/**
 * Submit a task to the UI queue.
 *
 * - `type === 'review'` and session is already complete → task is dropped
 *   (a warning is logged via a deferred `log` task). Returns `undefined`.
 * - Otherwise the task is enqueued and will run in FIFO order. Returns the
 *   task's result, or `undefined` if the task threw (errors are caught
 *   inside the queue slot so they cannot wipe the queue).
 * - If the caller type is not 'waiting' and a waiting task is currently
 *   idling on its rawlist, its abort controller fires so it returns promptly
 *   and the new task runs next.
 */
export function submitUITask<T>(
  type: UITaskType,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (_sessionComplete && type === 'review') {
    // Drop late review tasks; log a warning through the queue so the user sees it.
    submitUITask('log', async () => {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow('Dropping late review task — session already complete.'));
    });
    return Promise.resolve(undefined);
  }

  return new Promise<T | undefined>((resolve) => {
    uiQueue.push(async () => {
      _uiTaskActive = true;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        // NEVER rethrow — the queue's default error handler wipes the entire
        // queue on unhandled task rejection. Log and resolve with undefined so
        // the caller can detect failure via the sentinel value.
        // eslint-disable-next-line no-console
        console.error(chalk.red(`UI task (${type}) failed:`), err);
        resolve(undefined);
      } finally {
        _uiTaskActive = false;
      }
    });
    // Wake any idling waiting task so the newly pushed work runs next.
    if (type !== 'waiting' && currentWaitingAbort) {
      try { currentWaitingAbort.abort(); } catch { /* already aborted */ }
    }
  });
}

/**
 * Called by the watcher after initial-file processing completes to kick off
 * the self-sustaining waiting loop. Once started, every time the UI queue
 * drains AND the session isn't complete, a fresh waitingTask is enqueued.
 *
 * Uses queueMicrotask to avoid re-entering the 'end' event dispatch
 * synchronously — we want the queue's internal state fully settled before
 * pushing the next task.
 */
let loopStarted = false;
export const startUILoop = (): void => {
  if (loopStarted) return;
  loopStarted = true;
  if (!waitingTaskFactory) {
    // eslint-disable-next-line no-console
    console.error(chalk.red('startUILoop called before setWaitingTaskFactory — no-op'));
    return;
  }
  // Push the first waiting task now.
  submitUITask('waiting', waitingTaskFactory);
};

uiQueue.addEventListener('end', () => {
  if (!loopStarted) return;
  if (_sessionComplete) return;
  if (!waitingTaskFactory) return;
  queueMicrotask(() => {
    if (_sessionComplete) return;
    if (!waitingTaskFactory) return;
    submitUITask('waiting', waitingTaskFactory);
  });
});

/**
 * Reset module state. Intended for tests — do not call from production code.
 */
export const _resetForTests = (): void => {
  _uiTaskActive = false;
  currentWaitingAbort = null;
  _sessionComplete = false;
  _ctrlCPressed = false;
  waitingTaskFactory = null;
  loopStarted = false;
};

import fs from 'fs';
import path from 'path';

const verbose = process.argv.includes('--verbose');
let logFile: fs.WriteStream | null = null;

function getLogFile(): fs.WriteStream {
  if (!logFile) {
    const logDir = path.resolve('logs');
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    logFile = fs.createWriteStream(path.join(logDir, `cardlister-${timestamp}.log`), { flags: 'a' });
  }
  return logFile;
}

function formatArgs(args: unknown[]): string {
  return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
}

/**
 * Create a namespaced debug logger.
 * - Always writes to the log file (logs/cardlister-<timestamp>.log)
 * - Only prints to console when --verbose flag is present
 */
export function createLogger(namespace: string) {
  const prefix = `[${namespace}]`;

  return function debug(...args: unknown[]) {
    const timestamp = new Date().toISOString().slice(11, 23);
    const message = `${timestamp} ${prefix} ${formatArgs(args)}`;
    getLogFile().write(message + '\n');
    if (verbose) {
      console.error(message);
    }
  };
}

/** Close the log file stream. Call on process exit. */
export function closeLogger() {
  if (logFile) {
    logFile.end();
    logFile = null;
  }
}

process.on('exit', closeLogger);

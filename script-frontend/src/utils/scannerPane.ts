import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Split the iTerm session we are running in and start `yarn scan` in the new
 * pane, pointed at the same input directory, so scanned pairs land where watch
 * mode picks them up. The scanner lives in its own pane rather than as a child
 * process: it needs the TTY for its spinners, previews and raw-mode Ctrl-C, and
 * it can be stopped and restarted there without touching this process.
 *
 * Arguments go through argv and `quoted form of` so directory names never have
 * to survive AppleScript or shell quoting.
 */
const SPLIT_SCRIPT = `
on run argv
  set sessionId to item 1 of argv
  set cmd to "cd " & quoted form of (item 2 of argv) & " && yarn scan " & quoted form of (item 3 of argv)
  tell application "iTerm2"
    set target to missing value
    if sessionId is not "" then
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if unique id of s is sessionId then set target to s
          end repeat
        end repeat
      end repeat
    end if
    if target is missing value then set target to current session of current window
    tell target
      set scanPane to (split horizontally with default profile)
    end tell
    tell scanPane to write text cmd
  end tell
end run
`;

export const canOpenScannerPane = (): boolean => process.env.TERM_PROGRAM === 'iTerm.app';

/** Is a scanner already running (say, in a pane left over from an earlier run)? */
export const scannerRunning = async (): Promise<boolean> => {
  try {
    await execFileAsync('pgrep', ['-f', 'src/scan\\.ts']);
    return true;
  } catch {
    return false;
  }
};

export const openScannerPane = async (inputDirectory: string): Promise<void> => {
  // ITERM_SESSION_ID looks like "w0t1p0:<uuid>"; the uuid is the session's unique id.
  const sessionId = process.env.ITERM_SESSION_ID?.split(':')[1] ?? '';
  await execFileAsync('osascript', ['-e', SPLIT_SCRIPT, sessionId, process.cwd(), inputDirectory]);
};

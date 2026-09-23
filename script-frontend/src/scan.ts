import { configDotenv } from 'dotenv';
import chalk from 'chalk';
import { spawn, type ChildProcess } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { onShutdown } from 'node-graceful-shutdown';
import {
  useSpinners,
  showSpinner as showCardSpinner,
  updateSpinner,
  finishSpinner,
  errorSpinner,
} from './utils/spinners.js';
import { parseArgs } from './utils/parseArgs';
import { getInputs } from './utils/inputs';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

configDotenv();

const args = parseArgs(
  {
    boolean: ['o'],
    alias: { o: 'raw' },
  },
  {
    o: 'Raw mode: skip hardware deskew/crop and enable overscan, giving the full frame with background margin on all four sides. For cards the default crops too tightly.',
  },
);

const { log } = useSpinners('Scan', chalk.magentaBright);

// ── Scanner settings ──────────────────────────────────────────────────────────
// Geometry is deliberately much larger than a 2.5x3.5in (63.5x88.9mm) card. A
// card skewed 10deg needs a ~78x99mm bounding box, and in raw mode overscan
// shifts it further down and right. Too tight and cards clip silently, which is
// worse than an outright failure because the images still look plausible.
const RAW = !!args.raw;
const SETTINGS = {
  source: process.env.SCAN_SOURCE || 'ADF Duplex',
  mode: process.env.SCAN_MODE || 'Color',
  resolution: process.env.SCAN_RES || '400',
  pageWidth: process.env.SCAN_PAGE_W || '110',
  pageHeight: process.env.SCAN_PAGE_H || '130',
  brightness: process.env.SCAN_BRIGHTNESS || '0',
  contrast: process.env.SCAN_CONTRAST || '0',
  // Hardware deskew+crop straightens the card, auto-orients it and crops to its
  // real edges. Off in raw mode, where overscan supplies margin instead; the two
  // are mutually exclusive since the crop removes the margin overscan adds.
  deskewCrop: RAW ? 'no' : 'yes',
  overscan: RAW ? 'On' : 'Off',
  // buffermode MUST stay Off. With it On the scanner races ahead pulling cards
  // into internal memory, so a stall strands them: physically fed, never
  // captured, and afterwards indistinguishable from cards that scanned fine.
  bufferMode: process.env.SCAN_BUFFERMODE || 'Off',
  prepick: process.env.SCAN_PREPICK || 'Default',
};

// The scanner intermittently stops mid-transport and scanimage then waits
// forever for bytes that never arrive, so progress is watchdogged. Measured
// healthy gaps are 0s between the two sides of a card and 2-3s between cards.
// The first page of a batch also covers feeding and lamp start, so it gets a
// longer grace.
const STALL_MS = Number(process.env.SCAN_STALL_SECONDS || 5) * 1000;
const FIRST_PAGE_MS = Number(process.env.SCAN_FIRST_PAGE_SECONDS || 25) * 1000;
const POLL_MS = 250;
const IDLE_MS = Number(process.env.POLL_SECONDS || 3) * 1000;
// Let a freshly loaded stack settle before starting. The ultrasonic double-feed
// sensor reads a stack that is still moving as a double feed, which the backend
// reports as "Document feeder jammed" (omr-df=yes, error-code=49). That is why
// the first card of a batch used to fail and the retry always succeeded, and
// why VueScan never shows it -- it waits for you to click Scan, by which time
// the cards have been still for seconds.
const SETTLE_MS = Number(process.env.SCAN_SETTLE_SECONDS || 2) * 1000;

// ── Tone ──────────────────────────────────────────────────────────────────────
// The SANE backend hands back near-linear data that never reaches white: a card
// measured p1=2, p50=58, p99=176, with 15% of it crushed to black and nothing
// above 176. VueScan looks dramatically better on the same card only because it
// post-processes -- its ini sets WhitePoint to 8.96% and it applies the usual
// ~2.2 gamma encode on output.
//
// So the same correction is applied here: stretch so the top WHITE_CLIP% of
// pixels reach white, then gamma-encode. Measured against a VueScan scan of the
// same card, this lands p50 154 vs 153 and mean 155 vs 157, while clipping less
// highlight detail (6.9% vs 9.7%).
//
// The white point is computed per image, as VueScan does, so a dark card is
// lifted as much as it needs rather than by a fixed amount.
const TONE = (process.env.SCAN_TONE || 'on').toLowerCase() !== 'off';
const WHITE_CLIP = Number(process.env.SCAN_WHITE_CLIP || 1);
const GAMMA = Number(process.env.SCAN_GAMMA || 2.2);
const JPEG_QUALITY = Number(process.env.SCAN_JPEG_QUALITY || 95);

// ── Staging ───────────────────────────────────────────────────────────────────
// Cards are assembled here and only moved to the input directory once both sides
// are present. The listing pipeline ingests files the instant they appear, so
// anything written there is committed -- deleting it afterwards cannot un-ingest
// it. Resolving pairs in staging is what makes discarding a half-scanned card
// possible at all.
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'cardscan-'));

let activeScan: ChildProcess | undefined;
let stopping = false;

const cleanup = async () => {
  stopping = true;
  if (activeScan && !activeScan.killed) activeScan.kill('SIGINT');
  await fs.remove(STAGE).catch(() => {});
};
onShutdown(cleanup);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findDevice = async (): Promise<string> => {
  if (process.env.SCANNER_DEVICE) return process.env.SCANNER_DEVICE;
  const { stdout } = await execFileAsync('scanimage', ['-f', '%d%n']);
  const device = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('fujitsu:'));
  if (!device) throw new Error('No Fujitsu scanner found. Check that it is powered on and connected.');
  return device;
};

/**
 * Levels-stretch and gamma-encode one scan, writing the result to `dest`.
 * Returns false if anything goes wrong, so the caller can fall back to moving
 * the untouched file rather than losing the scan.
 */
const enhance = async (src: string, dest: string): Promise<boolean> => {
  try {
    const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Luminance histogram -> the value below which (100 - WHITE_CLIP)% of pixels sit.
    const hist = new Array(256).fill(0);
    let n = 0;
    for (let i = 0; i < width * height * channels; i += channels) {
      hist[Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)]++;
      n++;
    }
    let cum = 0;
    let hi = 255;
    for (let v = 255; v >= 0; v--) {
      cum += hist[v];
      if (cum >= (n * WHITE_CLIP) / 100) {
        hi = v;
        break;
      }
    }
    if (hi < 16) hi = 255; // near-black image; leave it alone rather than blow it out

    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.round(255 * Math.pow(Math.min(1, v / hi), 1 / GAMMA));
    }
    for (let i = 0; i < data.length; i++) data[i] = lut[data[i]];

    await sharp(data, { raw: { width, height, channels } }).jpeg({ quality: JPEG_QUALITY }).toFile(dest);
    return true;
  } catch {
    return false;
  }
};

/** Is anything in the hopper? Reads the scanner's page-loaded hardware sensor. */
const paperPresent = async (device: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync('scanimage', ['-d', device, '-A']);
    const line = stdout.split('\n').find((l) => l.includes('--page-loaded'));
    return !!line && /\[yes\]/.test(line);
  } catch {
    return false;
  }
};

/** Highest NNNN already used, across every date prefix, so we never overwrite. */
const nextIndex = async (dest: string): Promise<number> => {
  const files = await fs.readdir(dest).catch(() => [] as string[]);
  return (
    files
      .filter((f) => f.endsWith('.jpg'))
      .reduce((max, f) => {
        const n = Number(path.basename(f, '.jpg').split('-').pop());
        return Number.isFinite(n) && n > max ? n : max;
      }, 0) + 1
  );
};

const stagedFiles = async (): Promise<string[]> =>
  (await fs.readdir(STAGE).catch(() => [] as string[])).filter((f) => f.startsWith('raw-')).sort();

const datePrefix = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const scanArgs = (device: string) => [
  '-d',
  device,
  '--source',
  SETTINGS.source,
  '--mode',
  SETTINGS.mode,
  '--resolution',
  SETTINGS.resolution,
  '--page-width',
  SETTINGS.pageWidth,
  '--page-height',
  SETTINGS.pageHeight,
  '-x',
  SETTINGS.pageWidth,
  '-y',
  SETTINGS.pageHeight,
  '--brightness',
  SETTINGS.brightness,
  '--contrast',
  SETTINGS.contrast,
  '--overscan',
  SETTINGS.overscan,
  `--hwdeskewcrop=${SETTINGS.deskewCrop}`,
  // Card stock is thicker than paper, so the fi-7160's jam-prediction and
  // ultrasonic double-feed sensors both false-trigger on every card. Without
  // these four flags the scanner aborts with "Document feeder jammed"
  // (omr-df=yes, error-code=49) before transferring any data. It is not a real
  // jam, and correct page geometry alone does NOT fix it.
  '--paper-protect',
  'Off',
  '--adv-paper-protect',
  'Off',
  '--df-action',
  'Continue',
  '--df-recovery',
  'Off',
  '--buffermode',
  SETTINGS.bufferMode,
  '--prepick',
  SETTINGS.prepick,
  '--format=jpeg',
  `--batch=${path.join(STAGE, 'raw-%04d.jpg')}`,
  '--batch-start=1',
];

/**
 * scanimage traps SIGINT and calls sane_cancel/sane_close, which releases the
 * USB device properly. SIGTERM/SIGKILL skip that teardown and leave the fi-7160
 * wedged -- libusb still sees it but the backend cannot enumerate it until a
 * power cycle -- so always escalate from SIGINT.
 */
const stopScan = async (proc: ChildProcess) => {
  proc.kill('SIGINT');
  for (let i = 0; i < 10; i++) {
    if (proc.exitCode !== null || proc.signalCode) return;
    await sleep(1000);
  }
  log(chalk.yellow('Scan did not exit on SIGINT; forcing it. The scanner may need a power cycle.'));
  proc.kill('SIGTERM');
  await sleep(2000);
  if (proc.exitCode === null) proc.kill('SIGKILL');
};

const run = async () => {
  const dest = await getInputs(args);
  await fs.ensureDir(dest);
  const device = await findDevice();

  log(
    chalk.dim(
      `${SETTINGS.source}, ${SETTINGS.mode}, ${SETTINGS.resolution}dpi, ` +
        (RAW ? `raw ${SETTINGS.pageWidth}x${SETTINGS.pageHeight}mm frame` : 'deskew+crop to card edges'),
    ),
  );

  // One spinner per card, driven through its own lifecycle: it sits on "waiting"
  // until a page lands, switches to "scanning", then resolves green with the
  // filenames written or red if the card only gave up one side. The low-level
  // spinner API is used directly so each stage sets its own text -- useSpinners
  // fixes the message at creation, which would leave a finished card still
  // reading "Waiting for cards".
  let consecutiveJams = 0;
  let cardNum = 0;
  let cardId = `scan-card-${++cardNum}`;
  let scanningShown = false;

  showCardSpinner(cardId, chalk.dim('Waiting for cards'));

  const nextCard = () => {
    cardId = `scan-card-${++cardNum}`;
    scanningShown = false;
    showCardSpinner(cardId, chalk.dim('Waiting for cards'));
  };

  /**
   * Move finished CARDS out of staging. scanimage writes a duplex card as two
   * consecutive files, front then back, so a card is only usable as a pair. A
   * staged file is known-complete once the next one exists (scanimage writes
   * sequentially), so while a scan runs the newest is held back as possibly
   * still being written; `final` means the scan has exited and all are complete.
   */
  const release = async (final: boolean): Promise<number> => {
    const staged = await stagedFiles();
    if (staged.length === 0) return 0;

    const complete = final ? staged.length : staged.length - 1;
    const pairs = Math.floor(complete / 2);
    let moved = 0;

    if (pairs > 0) {
      let idx = await nextIndex(dest);
      const prefix = datePrefix();
      for (let p = 0; p < pairs; p++) {
        const names: string[] = [];
        for (let side = 0; side < 2; side++) {
          let target = path.join(dest, `${prefix}-${String(idx).padStart(4, '0')}.jpg`);
          while (await fs.pathExists(target)) {
            idx++;
            target = path.join(dest, `${prefix}-${String(idx).padStart(4, '0')}.jpg`);
          }
          const stagedPath = path.join(STAGE, staged[p * 2 + side]);
          if (!TONE || !(await enhance(stagedPath, target))) {
            await fs.move(stagedPath, target);
          } else {
            await fs.remove(stagedPath);
          }
          names.push(path.basename(target));
          idx++;
          moved++;
        }
        finishSpinner(cardId, chalk.green(names.join(' + ')));
        nextCard();
      }
    }

    // A leftover single at end of batch is a card that only gave up one side.
    // Drop it here, where the pipeline has never seen it, and say so loudly --
    // the card has to go back through the feeder.
    if (final && complete % 2 === 1) {
      const orphan = staged[complete - 1];
      await fs.remove(path.join(STAGE, orphan));
      errorSpinner(cardId, chalk.red(`Deleting single image - put this card back in the stack (${orphan})`));
      nextCard();
    }

    return moved;
  };

  while (!stopping) {
    // Wait for cards rather than firing scans at an empty feeder. Polling the
    // sensor avoids issuing a feed command every few seconds, and the settle
    // delay keeps the double-feed sensor from reading a stack that is still
    // being loaded as a jam.
    while (!stopping && !(await paperPresent(device))) {
      await sleep(IDLE_MS);
    }
    if (stopping) break;
    await sleep(SETTLE_MS);

    await fs.emptyDir(STAGE);

    const proc = spawn('scanimage', scanArgs(device), { stdio: ['ignore', 'ignore', 'pipe'] });
    activeScan = proc;
    let stderr = '';
    proc.stderr?.on('data', (chunk) => (stderr += chunk.toString()));

    const exited = new Promise<void>((resolve) => proc.on('close', () => resolve()));

    let sawPage = false;
    let lastProgress = Date.now();
    let stalled = false;
    let seen = 0;
    // Cards released while the scan is still running count toward the batch too.
    let batchMoved = 0;

    while (proc.exitCode === null && !proc.signalCode) {
      const staged = await stagedFiles();
      if (staged.length > seen) {
        seen = staged.length;
        sawPage = true;
        lastProgress = Date.now();
        if (!scanningShown) {
          updateSpinner(cardId, chalk.cyan('Scanning card'));
          scanningShown = true;
        }
        batchMoved += await release(false);
      } else {
        const limit = sawPage ? STALL_MS : FIRST_PAGE_MS;
        if (Date.now() - lastProgress > limit) {
          stalled = true;
          await stopScan(proc);
          break;
        }
      }
      await sleep(POLL_MS);
    }

    await exited;
    activeScan = undefined;

    batchMoved += await release(true);

    if (!/jammed/i.test(stderr)) consecutiveJams = 0;

    if (stalled) {
      log(
        chalk.yellow(
          `Scanner stalled - ${batchMoved / 2} card(s) kept. Cards are still in the feeder; leave them to retry.`,
        ),
      );
      await sleep(IDLE_MS);
    } else if (batchMoved > 0) {
      // Cards were scanned; loop straight back for the next batch.
    } else if (/out of documents/i.test(stderr)) {
      // Feeder emptied between the sensor check and the scan; just loop back.
    } else if (/jammed/i.test(stderr)) {
      // The first sane_start of a batch reports a jam (omr-df=yes,
      // error-code=49) and the immediate retry always succeeds, so this is
      // transient and not worth alarming about. It is only surfaced if it stops
      // clearing on its own, which would mean a real jam.
      consecutiveJams++;
      if (consecutiveJams >= 4) {
        log(chalk.red(`Feeder jammed ${consecutiveJams}x in a row - check for a stuck card.`));
      }
    } else if (stderr.trim() && !stopping) {
      const detail = stderr
        .split('\n')
        .filter((l) => l.trim() && !/rounded value/.test(l))
        .slice(0, 3)
        .join('; ');
      log(chalk.red(`Scanner error: ${detail}`));
      await sleep(IDLE_MS);
    }
  }
};

try {
  await run();
} catch (e) {
  log(chalk.red(e instanceof Error ? e.message : String(e)));
  await cleanup();
  process.exit(1);
}

import type { MoneyAmount, Product, ProductVariant } from '@medusajs/client-types';
import chalk from 'chalk';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import sharp from 'sharp';
import terminalImage from 'term-img';
import { ask } from './ask.js';
import { pauseSpinners, resumeSpinners } from './spinners.js';

export type CropResult = { file: string | null; method: string };

export type ReviewMenuState = {
  cardTitle: string;
  quantity: number;
  // True when `quantity` was populated from an existing Medusa inventory
  // count (i.e. this card is already stocked) rather than the new-listing
  // default of 1. Drives the "(in stock)" indicator and the + hotkey hint —
  // a backend-sourced 1 means "you already have one, scanning a duplicate
  // should bump this to 2", not "set stock to 1".
  quantityFromBackend: boolean;
  prices: { ebay: number; mcp: number; bsc: number; sportlots: number };
  priceMoneyAmounts: MoneyAmount[];
  frontCrop: CropResult;
  backCrop: CropResult | null;
  details: { thickness: string; features: string[] };
  // Card match info
  matchedProduct: Product | null;
  matchedVariant: ProductVariant | null;
  matchConfidence: number; // scoring from matchCard
  // All variants of the matched product — drives the inline variations block
  // and the (V) hotkey. Empty or single-entry means no variant switching UI.
  availableVariants: ProductVariant[];
  // Side info
  frontPath: string;
  backPath: string;
  // Pre-crop source paths — used by the 'c' re-crop handler so it always
  // crops from the original image instead of re-cropping an already-cropped
  // intake output. Unset when no pre-crop happened (non-watch mode or
  // autoCrop failure).
  originalFrontPath?: string;
  originalBackPath?: string;
  sidesSwapped: boolean;
  // Queue info (set externally)
  queuedCount: number;
  // Rejection (set by x/X/u keys): caller should skip finalize.
  //   'front' | 'back' — that scan is bad: discard it, return the other side
  //     to the pool, and wait for a rescan of the rejected side.
  //   'both' — the two scans are different cards that were wrongly paired:
  //     keep both images, return both to the pool, and make sure they are
  //     never paired with each other again.
  rejected?: 'front' | 'back' | 'both';
};

export type ReviewMenuCallbacks = {
  onPrice: () => Promise<{ prices: MoneyAmount[]; display: ReviewMenuState['prices'] }>;
  onCrop: (side: 'front' | 'back') => Promise<CropResult>;
  onRotate: (side: 'front' | 'back') => Promise<void>;
  onDetails: () => Promise<{ thickness: string; features: string[] }>;
  onSwapSides: () => Promise<void>;
  onManualSelect: () => Promise<{
    product: Product;
    variant: ProductVariant;
    quantity: number;
    quantityFromBackend: boolean;
    prices: MoneyAmount[];
    priceDisplay: ReviewMenuState['prices'];
  } | null>;
  onVariantSelect: () => Promise<{
    variant: ProductVariant;
    quantity: number;
    quantityFromBackend: boolean;
    prices: MoneyAmount[];
    priceDisplay: ReviewMenuState['prices'];
  } | null>;
};

function variantLabel(variant: ProductVariant): string {
  return variant.metadata?.variationName
    || (variant.metadata?.isBase ? 'Base' : null)
    || variant.title
    || 'Unknown';
}

function confidenceColor(score: number): (s: string) => string {
  if (score >= 5000) return chalk.green;
  if (score >= 2000) return chalk.yellow;
  return chalk.red;
}

/**
 * Number of terminal rows the menu below the images needs. Used to size the
 * image preview so the whole review screen (images + menu) fits on one page
 * without scrolling.
 */
function menuRowCount(state: ReviewMenuState): number {
  const variantRows = state.availableVariants && state.availableVariants.length > 1
    ? state.availableVariants.length + 3 // header + rows + blank + hotkey row
    : 0;
  return 17 + variantRows;
}

/**
 * Pick an image height (in terminal rows) that leaves room for the menu.
 * Falls back to a conservative default when the terminal size is unknown.
 */
function previewHeightRows(state: ReviewMenuState): number {
  const rows = process.stdout.rows || 40;
  const available = rows - menuRowCount(state) - 2; // 2 = padding around the image block
  return Math.max(6, Math.min(18, available));
}

/**
 * Compose the front and back scans into one side-by-side PNG so they render
 * on the same line. Both sides are scaled to a common height; a small gap
 * separates them. Returns null if either image can't be read.
 */
async function composeSideBySide(frontPath: string, backPath: string): Promise<string | null> {
  try {
    const TARGET_H = 600;
    const GAP = 24;
    // Border is 2 source px so it still reads as a hairline after the terminal
    // scales the composite down to fit the available rows.
    const BORDER = 2;
    const BORDER_COLOR = { r: 0, g: 200, b: 0, alpha: 1 };
    const sides = await Promise.all(
      [frontPath, backPath].map(async (p) => {
        const buf = await sharp(p)
          .resize({ height: TARGET_H - BORDER * 2, fit: 'inside' })
          .extend({ top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, background: BORDER_COLOR })
          .png()
          .toBuffer();
        const meta = await sharp(buf).metadata();
        return { buf, width: meta.width ?? 0, height: meta.height ?? TARGET_H };
      }),
    );
    const height = Math.max(...sides.map((s) => s.height));
    const width = sides.reduce((sum, s) => sum + s.width, 0) + GAP;
    const out = path.join(os.tmpdir(), `review-pair-${process.pid}.png`);
    await sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: sides[0].buf, left: 0, top: Math.floor((height - sides[0].height) / 2) },
        { input: sides[1].buf, left: sides[0].width + GAP, top: Math.floor((height - sides[1].height) / 2) },
      ])
      .png()
      .toFile(out);
    return out;
  } catch {
    return null;
  }
}

async function printCardImages(state: ReviewMenuState): Promise<void> {
  const fullHeight = previewHeightRows(state);
  const show = async (p: string, height: number) => {
    try {
      const out = await terminalImage(p, { height });
      process.stdout.write('  ' + out + '\n');
    } catch {
      process.stdout.write(`  ${chalk.dim(`[Image: ${p.split('/').pop()}]`)}\n`);
    }
  };

  // Blank line so the image block isn't jammed against the text above it.
  process.stdout.write('\n');

  const hasBack = !!state.backPath && state.backPath !== state.frontPath;
  if (hasBack) {
    const combined = await composeSideBySide(state.frontPath, state.backPath!);
    if (combined) {
      await show(combined, fullHeight);
      return;
    }
  }

  // Fallback: single side, or composition failed — render each side on its
  // own line, halving the height so both still fit above the menu.
  const stackedHeight = hasBack ? Math.max(4, Math.floor(fullHeight / 2)) : fullHeight;
  await show(state.frontPath, stackedHeight);
  if (hasBack) {
    await show(state.backPath!, stackedHeight);
  }
}

function cropLabel(crop: CropResult | null): string {
  if (!crop) return chalk.dim('none');
  if (!crop.file) return chalk.red('FAILED');
  return chalk.green(crop.method);
}

/**
 * Render the single-keystroke menu. The key letter in parens is highlighted.
 * Returns the number of lines written, so callers doing a live in-place
 * redraw (e.g. while the user is typing digits into the quantity slot) know
 * how many lines to move the cursor up before reprinting.
 */
function printMenu(state: ReviewMenuState, quantityBuffer: string | null = null, errorMsg: string | null = null): number {
  const k = (letter: string) => chalk.yellow.bold(`(${letter})`);

  const titleLine = state.matchedProduct
    ? confidenceColor(state.matchConfidence)(
        `${state.cardTitle} (score: ${state.matchConfidence})`,
      )
    : chalk.red(`${state.cardTitle || 'Unknown card'} — no match`);

  const qtyDisplay = quantityBuffer !== null
    ? chalk.bgGreen.black(` ${quantityBuffer || ' '} `) + chalk.dim(' (typing…)')
    : state.quantityFromBackend
      ? chalk.cyan(String(state.quantity)) + chalk.dim(' (in stock — press ') + k('+') + chalk.dim(' to add this copy)')
      : chalk.green(String(state.quantity));

  const manualLabel = state.matchedProduct
    ? k('M') + 'anual card select'
    : k('M') + 'anual card select ' + chalk.red('← required');

  const queueInfo = state.queuedCount > 0
    ? chalk.dim(`    [${state.queuedCount} card${state.queuedCount === 1 ? '' : 's'} queued]`)
    : '';

  const hasMultipleVariants = state.availableVariants && state.availableVariants.length > 1;
  const variationLines: string[] = [];
  if (hasMultipleVariants) {
    variationLines.push('  ' + chalk.yellow.bold(`Variations`) + chalk.dim(` (press `) + k('V') + chalk.dim(` to switch):`));
    const selectedId = state.matchedVariant?.id;
    for (const v of state.availableVariants) {
      const label = variantLabel(v);
      if (v.id === selectedId) {
        variationLines.push('     ' + chalk.green.bold('▸ ' + label));
      } else {
        variationLines.push('       ' + chalk.dim(label));
      }
    }
    variationLines.push('');
  }

  const variantHotkeyRow = hasMultipleVariants
    ? '  ' + k('V') + 'ariant: ' + chalk.green(variantLabel(state.matchedVariant!))
    : null;

  const lines: string[] = [
    '',
    ...variationLines,
    '  ' + titleLine,
    '',
    '  ' + k('Q') + 'uantity: ' + qtyDisplay,
    '  ' + k('P') + 'rice: ' +
      `eBay ${chalk.green(String(state.prices.ebay))}, ` +
      `MCP ${chalk.green(String(state.prices.mcp))}, ` +
      `BSC ${chalk.green(String(state.prices.bsc))}, ` +
      `SL ${chalk.green(String(state.prices.sportlots))}`,
    '  ' + k('C') + 'rop front: ' + cropLabel(state.frontCrop) +
      '    ' + k('Shift+C') + ' Crop back: ' + cropLabel(state.backCrop),
    '  ' + k('R') + 'otate front' +
      '        ' + k('Shift+R') + ' Rotate back',
    '  ' + k('X') + ' Reject front' +
      '      ' + k('Shift+X') + ' Reject back ' +
      chalk.dim('(rescan the rejected side)'),
    '  ' + k('U') + 'npair ' +
      chalk.dim('(front & back are different cards — both return to the pool)'),
    '  ' + k('S') + 'wap sides' +
      (state.sidesSwapped ? chalk.yellow('  (swapped)') : ''),
    '  ' + manualLabel,
    ...(variantHotkeyRow ? [variantHotkeyRow] : []),
    '  ' + k('D') + 'etails: ' +
      `${state.details.thickness}, ${state.details.features.join(', ') || 'Base Set'}`,
    '',
    '  ' + chalk.bold('[Enter]') + ' = Accept and continue' + queueInfo,
    '',
  ];

  if (errorMsg) {
    lines.push('  ' + chalk.red('Error: ' + errorMsg), '');
  }

  process.stdout.write(lines.join('\n') + '\n');
  return lines.length;
}

type Keypress = { name?: string; sequence?: string; ctrl?: boolean };

/**
 * Print a single status line before running an async operation, then report
 * the elapsed time on completion or failure. We deliberately do NOT animate
 * — `cropImage` writes the term-img preview and the "Did this render
 * correctly?" prompt to stdout, and an in-place \r-based spinner clobbers
 * those. Static lines compose cleanly with whatever the inner call prints.
 */
async function runWithStatus<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log('  ' + chalk.cyan('⏳') + ' ' + label);
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('  ' + chalk.green('✓') + ' ' + label + ' ' + chalk.dim(`(${elapsed}s)`));
    return result;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const msg = err instanceof Error ? err.message : String(err);
    console.log('  ' + chalk.red('✗') + ' ' + label + ' ' + chalk.dim(`(${elapsed}s)`) + ' — ' + chalk.red(msg));
    throw err;
  }
}

/**
 * Read a single keystroke from stdin in raw mode, then restore cooked mode so
 * subsequent @inquirer/prompts calls (price, details, quantity) work normally.
 */
function readSingleKey(): Promise<{ char: string; key: Keypress }> {
  return new Promise((resolve) => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw ?? false;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const onKey = (str: string, key: Keypress) => {
      if (key && key.ctrl && key.name === 'c') {
        stdin.removeListener('keypress', onKey);
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.pause();
        process.kill(process.pid, 'SIGINT');
        return;
      }
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve({ char: str ?? '', key: key ?? {} });
    };
    stdin.on('keypress', onKey);
  });
}

async function askQuantity(current: number): Promise<number> {
  const raw = await ask('Quantity', current, {
    validate: (v) => v === '' || !isNaN(Number(v)) ? true : 'Must be a number',
  });
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function showReviewMenu(
  state: ReviewMenuState,
  callbacks: ReviewMenuCallbacks,
): Promise<ReviewMenuState> {
  // Pause all background spinners for the entire duration of the review menu —
  // including sub-action callbacks like onPrice/onCrop/onDetails. pause/resume
  // is reference-counted in spinners.ts, so nested log() calls inside callbacks
  // compose correctly and never prematurely un-pause.
  pauseSpinners();
  try {
    let lastError: string | null = null;

    await printCardImages(state);
    let lastMenuLines = printMenu(state);

    // If non-null, user is typing directly into the quantity slot. The buffer
    // is committed to state.quantity on Enter, any action letter, or when the
    // user backspaces past empty.
    let quantityBuffer: string | null = null;
    const commitQuantity = () => {
      if (quantityBuffer !== null) {
        const n = parseInt(quantityBuffer, 10);
        if (Number.isFinite(n)) state.quantity = n;
        quantityBuffer = null;
      }
    };

    // Surgically redraw the menu in place — move cursor up over the previous
    // render and clear to end-of-screen. Used while the user is typing into
    // the quantity slot so the menu text doesn't stack up beneath itself.
    const redrawMenu = (buffer: string | null) => {
      process.stdout.write(`\x1b[${lastMenuLines}A\r\x1b[0J`);
      lastMenuLines = printMenu(state, buffer, lastError);
    };

    while (true) {
      const { char, key } = await readSingleKey();

      // Direct digit entry into quantity slot.
      if (char && char >= '0' && char <= '9') {
        if (quantityBuffer === null) quantityBuffer = '';
        // Cap at 4 digits — nobody has 10k of one card.
        if (quantityBuffer.length < 4) quantityBuffer += char;
        redrawMenu(quantityBuffer);
        continue;
      }

      // Backspace while editing quantity.
      if (quantityBuffer !== null && (key.name === 'backspace' || key.name === 'delete')) {
        quantityBuffer = quantityBuffer.slice(0, -1);
        redrawMenu(quantityBuffer);
        continue;
      }

      // Enter = accept and continue (commits any pending quantity first).
      if (key.name === 'return' || key.name === 'enter') {
        commitQuantity();
        if (!state.matchedProduct) {
          console.log(chalk.red('  No card match — press M to select manually.'));
          continue;
        }
        if (!state.frontCrop.file) {
          console.log(chalk.red('  Front image must be cropped — press C to re-crop.'));
          continue;
        }
        return state;
      }

      // Any action letter commits a pending quantity edit before running.
      commitQuantity();

      lastError = null; // Clear previous error when starting a new action
      try {
        switch (char) {
          case 'q':
          case 'Q':
            state.quantity = await askQuantity(state.quantity);
            break;
          case '+':
          case '=':
            state.quantity += 1;
            break;
          case 'p':
          case 'P': {
            const result = await callbacks.onPrice();
            state.prices = result.display;
            state.priceMoneyAmounts = result.prices;
            break;
          }
          case 'c': {
            const result = await runWithStatus('Cropping front image…', () => callbacks.onCrop('front'));
            state.frontCrop = result;
            break;
          }
          case 'C': {
            const result = await runWithStatus('Cropping back image…', () => callbacks.onCrop('back'));
            state.backCrop = result;
            break;
          }
          case 'r':
            await callbacks.onRotate('front');
            break;
          case 'R':
            await callbacks.onRotate('back');
            break;
          case 'x':
            state.rejected = 'front';
            return state;
          case 'X':
            state.rejected = 'back';
            return state;
          case 'u':
          case 'U':
            state.rejected = 'both';
            return state;
          case 's':
          case 'S': {
            await callbacks.onSwapSides();
            const tmpPath = state.frontPath;
            state.frontPath = state.backPath;
            state.backPath = tmpPath;
            const tmpOrig = state.originalFrontPath;
            state.originalFrontPath = state.originalBackPath;
            state.originalBackPath = tmpOrig;
            const tmpCrop = state.frontCrop;
            state.frontCrop = state.backCrop ?? { file: null, method: 'none' };
            state.backCrop = tmpCrop;
            state.sidesSwapped = !state.sidesSwapped;
            break;
          }
          case 'm':
          case 'M': {
            const result = await callbacks.onManualSelect();
            if (result) {
              state.matchedProduct = result.product;
              state.matchedVariant = result.variant;
              state.availableVariants = result.product.variants ?? [result.variant];
              state.cardTitle = result.variant.title || result.product.title || state.cardTitle;
              state.matchConfidence = 10000; // User-confirmed
              state.quantity = result.quantity;
              state.quantityFromBackend = result.quantityFromBackend;
              state.priceMoneyAmounts = result.prices;
              state.prices = result.priceDisplay;
            }
            break;
          }
          case 'v':
          case 'V': {
            if (!state.availableVariants || state.availableVariants.length <= 1) {
              break; // No-op when there's nothing to switch to
            }
            const result = await callbacks.onVariantSelect();
            if (result) {
              state.matchedVariant = result.variant;
              state.cardTitle = result.variant.title
                || state.matchedProduct?.title
                || state.cardTitle;
              state.matchConfidence = 10000; // User-confirmed
              state.quantity = result.quantity;
              state.quantityFromBackend = result.quantityFromBackend;
              state.priceMoneyAmounts = result.prices;
              state.prices = result.priceDisplay;
            }
            break;
          }
          case 'd':
          case 'D': {
            const result = await callbacks.onDetails();
            state.details = result;
            break;
          }
          default:
            // Unknown key — re-read without reprinting.
            continue;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
      }

      await printCardImages(state);
      lastMenuLines = printMenu(state, null, lastError);
    }
  } finally {
    resumeSpinners();
  }
}

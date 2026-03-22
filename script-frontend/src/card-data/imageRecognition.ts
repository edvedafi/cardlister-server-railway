import { useSpinners } from '../utils/spinners.js';
import type { SetInfo } from '../models/setInfo';
import type { ImageRecognitionResults } from '../models/cards';
import type { Product } from '@medusajs/client-types';

const { showSpinner } = useSpinners('firebase', '#f4d02e');

// ── Extractor mode ──────────────────────────────────────────────────────────

export type ExtractorMode = 'ocr' | 'ollama' | 'haiku';
let extractorMode: ExtractorMode = 'ocr';

export function setExtractorMode(mode: ExtractorMode) {
  extractorMode = mode;
}

type ProductMatchResult = {
  product: Product;
  score: number;
} | null;

type ProductMatchResultWithPerfect = {
  perfectMatch: ProductMatchResult;
  bestMatch: ProductMatchResult;
};

/**
 * Match a product against structured card info extracted by the vision AI.
 */
function matchProductFromCardInfo(
  cardInfo: { player: string | null; team: string | null; card_number: string | null },
  products: Product[],
): ProductMatchResultWithPerfect {
  type ProductScore = { product: Product; score: number; perfectMatch: boolean };
  const scoredProducts: ProductScore[] = [];

  const extractedNumber = cardInfo.card_number?.toLowerCase().trim() ?? null;
  const extractedPlayer = cardInfo.player?.toLowerCase().trim() ?? null;

  for (const product of products) {
    let score = 0;
    const meta = product.metadata || {};
    const productCardNumber = ((meta.cardNumber as string) || '').toLowerCase().trim();
    const productPlayers = ((meta.player as string[]) || []).map((p) => p.toLowerCase().trim());

    // Card number match — most specific signal
    let cardNumberMatched = false;
    if (extractedNumber && productCardNumber) {
      if (extractedNumber === productCardNumber) {
        score += 2000;
        cardNumberMatched = true;
      }
    }

    // Player name match
    let playerMatched = false;
    if (extractedPlayer) {
      for (const productPlayer of productPlayers) {
        if (extractedPlayer === productPlayer) {
          score += 1000;
          playerMatched = true;
          break;
        } else if (extractedPlayer.includes(productPlayer) || productPlayer.includes(extractedPlayer)) {
          score += 400;
          playerMatched = true;
          break;
        }
      }
    }

    // Perfect match: both card number and player matched with high confidence
    const isPerfectMatch = cardNumberMatched && playerMatched;
    if (isPerfectMatch) {
      score += 3000;
    }

    scoredProducts.push({ product, score, perfectMatch: isPerfectMatch });
  }

  scoredProducts.sort((a, b) => b.score - a.score);

  const perfectMatch = scoredProducts.find((item) => item.perfectMatch);
  const bestMatch = scoredProducts[0];

  return {
    perfectMatch: perfectMatch && perfectMatch.score > 0
      ? { product: perfectMatch.product, score: perfectMatch.score }
      : null,
    bestMatch: bestMatch && bestMatch.score > 0
      ? { product: bestMatch.product, score: bestMatch.score }
      : null,
  };
}

/**
 * Match products against raw OCR words using fuzzy matching.
 */
function matchProductFromOCR(
  ocrWords: string[],
  products: Product[],
): ProductMatchResultWithPerfect {
  type ProductScore = { product: Product; score: number; perfectMatch: boolean };
  const scoredProducts: ProductScore[] = [];

  const lowerWords = ocrWords.map((w) => w.toLowerCase().trim()).filter(Boolean);
  const ocrText = lowerWords.join(' ');

  for (const product of products) {
    let score = 0;
    const meta = product.metadata || {};
    const productCardNumber = ((meta.cardNumber as string) || '').toLowerCase().trim();
    const productPlayers = ((meta.player as string[]) || []).map((p) => p.toLowerCase().trim());

    // Card number match — check if any OCR word matches the card number
    let cardNumberMatched = false;
    if (productCardNumber) {
      for (const word of lowerWords) {
        if (word === productCardNumber) {
          score += 2000;
          cardNumberMatched = true;
          break;
        }
      }
    }

    // Player name match — check if any product player name appears in the OCR text
    let playerMatched = false;
    for (const productPlayer of productPlayers) {
      if (!productPlayer) continue;
      if (ocrText.includes(productPlayer)) {
        // Check if it's an exact word-boundary match vs substring
        const playerWords = productPlayer.split(/\s+/);
        const allWordsFound = playerWords.every((pw) => lowerWords.some((w) => w === pw));
        if (allWordsFound) {
          score += 1000;
        } else {
          score += 400;
        }
        playerMatched = true;
        break;
      }
    }

    const isPerfectMatch = cardNumberMatched && playerMatched;
    if (isPerfectMatch) {
      score += 3000;
    }

    scoredProducts.push({ product, score, perfectMatch: isPerfectMatch });
  }

  scoredProducts.sort((a, b) => b.score - a.score);

  const perfectMatch = scoredProducts.find((item) => item.perfectMatch);
  const bestMatch = scoredProducts[0];

  return {
    perfectMatch: perfectMatch && perfectMatch.score > 0
      ? { product: perfectMatch.product, score: perfectMatch.score }
      : null,
    bestMatch: bestMatch && bestMatch.score > 0
      ? { product: bestMatch.product, score: bestMatch.score }
      : null,
  };
}

function applyMatchResult(
  matchResult: ProductMatchResultWithPerfect,
  defaults: Partial<ImageRecognitionResults>,
  finish: (msg: string) => void,
): Partial<ImageRecognitionResults> | null {
  const matchToUse = matchResult.perfectMatch || matchResult.bestMatch;
  if (!matchToUse) return null;

  const bestProduct = matchToUse.product;
  const bestMetadata = bestProduct.metadata || {};

  const result = {
    ...defaults,
    player: bestMetadata.player || defaults.player,
    cardNumber: bestMetadata.cardNumber || defaults.cardNumber,
    printRun: bestMetadata.printRun || defaults.printRun,
    features: (bestMetadata.features || defaults.features) as string[],
    _perfectMatch: matchResult.perfectMatch !== null,
    _bestMatchPlayer: matchResult.bestMatch?.product.metadata?.player || defaults.player,
  };

  if (matchResult.perfectMatch) {
    finish(`Perfect match found: ${bestProduct.title} (score: ${matchToUse.score})`);
  } else {
    finish(`Best match found: ${bestProduct.title} (score: ${matchToUse.score}) - will prompt for confirmation`);
  }

  return result;
}

async function getTextFromImage(front: string, back: string | undefined = undefined, setData: Partial<SetInfo> = {}) {
  const { update, error, finish } = showSpinner(`image-recognition-${front}`, `Image Recognition ${front}`);

  let defaults: Partial<ImageRecognitionResults> = {
    sport: setData.metadata?.sport,
    setName: setData.metadata?.setName,
    brand: setData.metadata?.brand,
    year: setData.metadata?.year,
    insert: setData.metadata?.insert,
    raw: [front],
  };
  if (back) {
    defaults.raw?.push(back);
  }

  if (setData.products && setData.products.length > 0) {
    if (extractorMode === 'ocr') {
      // EasyOCR + fuzzy matching (free, lightweight)
      try {
        update('Extracting text using EasyOCR');
        const { extractTextWithOCR } = await import('../image-processing/ocr-extractor.js');
        const { resizeImageForDisplay } = await import('../image-processing/imageProcessor.js');

        const backPath = back ?? front;
        const resizedFront = await resizeImageForDisplay(front);
        const resizedBack = await resizeImageForDisplay(backPath);
        const ocrResults = await extractTextWithOCR([resizedFront, resizedBack]);

        const allWords = ocrResults.flatMap((r) => r.words || []);
        update(`OCR found ${allWords.length} words, matching against ${setData.products.length} products`);

        const matchResult = matchProductFromOCR(allWords, setData.products);
        const result = applyMatchResult(matchResult, defaults, finish);
        if (result) return result;

        finish('No good product matches found (OCR)');
      } catch (e) {
        error(`EasyOCR extraction failed: ${String(e)}`);
      }
    } else {
      // Ollama or Haiku vision AI
      try {
        update(`Extracting card info using ${extractorMode} (card extractor)`);
        const { extractCardInfo } = await import('../image-processing/card-extractor.js');
        const { resizeImageForDisplay } = await import('../image-processing/imageProcessor.js');

        const backPath = back ?? front;
        const resizedFront = await resizeImageForDisplay(front);
        const resizedBack = await resizeImageForDisplay(backPath);
        const cardInfo = await extractCardInfo(resizedFront, resizedBack);

        const matchResult = matchProductFromCardInfo(cardInfo, setData.products);
        const result = applyMatchResult(matchResult, defaults, finish);
        if (result) return result;

        finish('No good product matches found');
      } catch (e) {
        error(`Card extractor failed: ${String(e)}`);
      }
    }
  } else {
    finish('No products to match against');
  }

  return defaults;
}

export default getTextFromImage;

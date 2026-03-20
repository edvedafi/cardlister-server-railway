import { useSpinners } from '../utils/spinners.js';
import type { SetInfo } from '../models/setInfo';
import type { ImageRecognitionResults } from '../models/cards';
import type { Product } from '@medusajs/client-types';

const { showSpinner } = useSpinners('firebase', '#f4d02e');

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
    try {
      update('Extracting card info using vision AI (card extractor)');
      const { extractCardInfo } = await import('../image-processing/card-extractor.js');
      const { resizeImageForDisplay } = await import('../image-processing/imageProcessor.js');

      const backPath = back ?? front;
      const resizedFront = await resizeImageForDisplay(front);
      const resizedBack = await resizeImageForDisplay(backPath);
      const cardInfo = await extractCardInfo(resizedFront, resizedBack);

      const matchResult = matchProductFromCardInfo(cardInfo, setData.products);
      const matchToUse = matchResult.perfectMatch || matchResult.bestMatch;

      if (matchToUse) {
        const bestProduct = matchToUse.product;
        const bestMetadata = bestProduct.metadata || {};

        defaults = {
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
        return defaults;
      }

      finish('No good product matches found');
    } catch (e) {
      error(`Card extractor failed: ${String(e)}`);
    }
  } else {
    finish('No products to match against');
  }

  return defaults;
}

export default getTextFromImage;

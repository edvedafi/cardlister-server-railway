import fs from 'fs';
import path from 'path';
import { useSpinners } from '../utils/spinners';
import { createLogger } from '../utils/logger';
import chalk from 'chalk';
import Queue from 'queue';
import { selectCard, getCardDetails, autoSelectCard, saveBulk, saveListing } from './cardData';
import terminalImage from 'term-img';
import { prepareImageFile } from '../image-processing/imageProcessor.js';
import { getProducts, startSync, updatePrices, updateInventory, getInventory, getInventoryQuantity, getRegion, getInventoryQuantitiesBatch } from '../utils/medusa';
import { ask, type AskSelectOption } from '../utils/ask';
import { submitUITask, wasCtrlCPressed } from '../utils/uiQueue';
import type { SetInfo } from '../models/setInfo';
import type { ProductImage } from '../models/cards';
import { processImageFile } from '../listing-sites/firebase';
import imageRecognition, { type PoolPriors } from './imageRecognition';
import type { InventoryItemDTO, Product, ProductVariant, MoneyAmount } from '@medusajs/client-types';
import { buildSet } from './setData';
import _ from 'lodash';
import type { ParsedArgs } from 'minimist';
import { getFiles, getInputs } from '../utils/inputs';
import { orientAndClassifyCards, orderFrontBack } from '../image-processing/card-cropper-wrapper';
import { getCommonPricing, getDefaultPricing, getPricing } from './pricing';
import { showReviewMenu, type ReviewMenuState } from '../utils/reviewMenu';
import type { UnmatchedCard } from '../utils/cardPool';

const { showSpinner, log } = useSpinners('list-set', chalk.cyan);
const debug = createLogger('listSet');

const listings: ProductVariant[] = [];
const cardProcessorQueue = new Queue({
  results: [],
  autostart: true,
  concurrency: 3,
});
// NOTE: the review queue has been replaced by the single serial UI queue in
// src/utils/uiQueue.ts. All interactive work — review menu, pool walk, idle
// waiting — runs as tasks on that queue.
const uploadQueue = new Queue({
  results: listings,
  autostart: true,
  concurrency: 3,
});

let hasUpdated = false;
let watchModeCropEnabled = false;

// Maps cropped image basename → original image basename for markScanned tracking
const cropOriginalNames = new Map<string, string>();

// Scanned file tracking for session recovery.
// Map of basename → mtimeMs recorded at scan time. A value of 0 means the
// entry came from a legacy scanned.txt line (filename only) and should be
// treated as "always skip" for backward compatibility.
let scannedFilePath = '';
const scannedFiles = new Map<string, number>();

function loadScannedFiles(inputDir: string): void {
  scannedFilePath = path.join(inputDir, 'scanned.txt');
  scannedFiles.clear();
  try {
    const content = fs.readFileSync(scannedFilePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tabIdx = trimmed.indexOf('\t');
      if (tabIdx === -1) {
        // Legacy line: filename only, no mtime known.
        scannedFiles.set(trimmed, 0);
      } else {
        const name = trimmed.slice(0, tabIdx);
        const mtime = Number(trimmed.slice(tabIdx + 1)) || 0;
        scannedFiles.set(name, mtime);
      }
    }
  } catch {
    // File doesn't exist yet — that's fine
  }
}

/**
 * Returns true if `filePath` is already recorded in scanned.txt AND the file
 * on disk hasn't been rewritten since. Files with the same name but a newer
 * mtime are treated as new (the user dropped a replacement scan).
 */
export function isFileScanned(filePath: string): boolean {
  const recorded = scannedFiles.get(path.basename(filePath));
  if (recorded === undefined) return false;
  if (recorded === 0) return true; // legacy entry — no mtime, always skip
  try {
    return fs.statSync(filePath).mtimeMs <= recorded;
  } catch {
    // Can't stat (file moved/deleted) — treat as scanned to avoid re-processing.
    return true;
  }
}

function markScanned(front: string, back: string): void {
  const names = [path.basename(front)];
  if (back && back !== front) names.push(path.basename(back));
  const inputDir = path.dirname(scannedFilePath);
  for (const name of names) {
    // Resolve cropped name back to the original scan filename
    const originalName = cropOriginalNames.get(name) ?? name;
    if (scannedFiles.has(originalName)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(inputDir, originalName)).mtimeMs;
    } catch {
      // Original file may already have been moved/deleted — record 0
      // so the entry acts as a legacy "always skip" marker.
    }
    scannedFiles.set(originalName, mtimeMs);
    fs.appendFileSync(scannedFilePath, `${originalName}\t${mtimeMs}\n`);
  }
}

const confirmCardSide = async (imagePath: string, detectedSide: 'front' | 'back'): Promise<'front' | 'back' | 'skip'> => {
  const options = detectedSide === 'front'
    ? ['front', 'back', 'skip']
    : ['back', 'front', 'skip'];
  const answer = await ask('Side:', undefined, {
    selectOptions: options,
  });
  return answer as 'front' | 'back' | 'skip';
};

const preProcessPair = async (imgA: string, imgB: string, setData: SetInfo, args: ParsedArgs) => {
  const { update, finish, error } = showSpinner(`singles-preprocess-${imgA}`, `Pre-Processing ${imgA}/${imgB}`);
  try {
    // Orient images and detect front/back via text density
    update(`Fixing orientation & detecting front/back`);
    const textDetections = await orientAndClassifyCards([imgA, imgB]);
    let [front, back] = textDetections.size > 0
      ? orderFrontBack(imgA, imgB, textDetections)
      : [imgA, imgB];

    // Let the user confirm or flip front/back assignment
    update(`Confirming front/back`);
    const sideA = await confirmCardSide(front, 'front');
    const sideB = await confirmCardSide(back, 'back');

    // If user flipped both or confirmed, apply the result
    if (sideA === 'back' && sideB === 'front') {
      [front, back] = [back, front];
    } else if (sideA === 'back') {
      // User says the detected front is actually the back — swap
      [front, back] = [back, front];
    } else if (sideB === 'front') {
      // User says the detected back is actually the front — swap
      [front, back] = [back, front];
    }

    update(`Getting image recognition data`);
    const imageDefaults = await imageRecognition(front, back, setData);
    update(`Queueing next step`);
    await submitUITask('review', async () => {
      await processPair(front, back, imageDefaults, setData, args);
    });
    finish();
  } catch (e) {
    error(e);
    throw e;
  }
};

/** Context passed from the card processor queue to the review and upload queues. */
interface CardProcessedState {
  menuState: ReviewMenuState;
  setData: SetInfo;
  args: ParsedArgs;
  imageDefaults: Partial<Product>;
  front: string;
  back: string;
}

/** Phase 1: Automated card identification — runs on cardProcessorQueue (concurrency 3). */
const buildCardState = async (front: string, back: string, setData: SetInfo, args: ParsedArgs, poolPriors?: PoolPriors): Promise<CardProcessedState> => {
  const { update, finish, error } = showSpinner(`singles-preprocess-${front}`, `Pre-Processing ${path.basename(front)}/${path.basename(back)}`);
  try {
    update(`Fixing orientation`);
    await orientAndClassifyCards([front, back]);

    update(`Getting image recognition data`);
    const imageDefaults = await imageRecognition(front, back, setData, poolPriors);

    update(`Auto-selecting card`);
    const autoResult = await autoSelectCard(setData, imageDefaults);

    update(`Getting default pricing`);
    const currentPrices = autoResult.productVariant?.prices ?? setData.category?.metadata?.prices ?? [];
    const pricingResult = await getDefaultPricing(currentPrices, args['allBase']);

    const features = autoResult.productVariant?.metadata?.features
      ?? autoResult.product?.metadata?.features
      ?? ['Base Set'];
    const thickness = autoResult.productVariant?.metadata?.thickness
      ?? autoResult.product?.metadata?.thickness
      ?? '20pt';

    let existingQuantity = 0;
    if (autoResult.productVariant) {
      try {
        existingQuantity = await getInventoryQuantity(autoResult.productVariant);
      } catch {
        // best-effort — default to 0
      }
    }

    const menuState: ReviewMenuState = {
      cardTitle: autoResult.productVariant?.title
        ?? autoResult.product?.title
        ?? `#${imageDefaults.cardNumber ?? '?'} ${Array.isArray(imageDefaults.player) ? imageDefaults.player.join(', ') : imageDefaults.player ?? 'Unknown'}`,
      quantity: existingQuantity,
      prices: pricingResult.display,
      priceMoneyAmounts: pricingResult.prices,
      frontCrop: { file: front, method: 'auto' },
      backCrop: { file: back, method: 'auto' },
      details: { thickness: String(thickness), features: Array.isArray(features) ? features : [features] },
      matchedProduct: autoResult.product,
      matchedVariant: autoResult.productVariant,
      matchConfidence: autoResult.confidence,
      frontPath: front,
      backPath: back,
      sidesSwapped: false,
      queuedCount: 0,
    };

    finish(`Ready for review: ${menuState.cardTitle}`);
    return { menuState, setData, args, imageDefaults, front, back };
  } catch (e) {
    error(e);
    throw e;
  }
};

/** Phase 2: Interactive review — runs on the UI queue (concurrency 1). Returns reviewed state. */
const reviewCard = async (state: CardProcessedState): Promise<ReviewMenuState> => {
  const { menuState, setData, args, imageDefaults, front } = state;

  menuState.queuedCount = cardProcessorQueue.length;

  const reviewed = await showReviewMenu(menuState, {
    onPrice: async () => {
      const cardMetadata = {
        year: setData.category?.metadata?.year,
        setName: setData.category?.metadata?.setName,
        insert: setData.metadata?.insert,
        parallel: setData.metadata?.parallel,
        player: menuState.matchedVariant?.metadata?.player ?? imageDefaults.player,
        cardName: menuState.matchedVariant?.metadata?.cardName ?? menuState.matchedProduct?.title,
      };
      const prices = await getPricing(
        menuState.priceMoneyAmounts,
        args['skipSafetyCheck'],
        args['allBase'],
        cardMetadata,
      );
      const newPricingResult = await getDefaultPricing(prices, false);
      return { prices, display: newPricingResult.display };
    },
    onCrop: async (side) => {
      const targetPath = side === 'front' ? menuState.frontPath : menuState.backPath;
      const { cropImage } = await import('../image-processing/imageProcessor.js');
      const cropDir = path.resolve(path.dirname(front), 'crop');
      fs.mkdirSync(cropDir, { recursive: true });
      const reCroppedPath = path.join(cropDir, `recrop-${Date.now()}.tmp.jpg`);
      await cropImage(targetPath, null, cropDir, reCroppedPath, false);
      cropOriginalNames.set(path.basename(reCroppedPath), path.basename(targetPath));
      if (side === 'front') {
        menuState.frontPath = reCroppedPath;
      } else {
        menuState.backPath = reCroppedPath;
      }
      return { file: reCroppedPath, method: 'manual' };
    },
    onRotate: async (side) => {
      const targetPath = side === 'front' ? menuState.frontPath : menuState.backPath;
      const sharp = (await import('sharp')).default;
      const buffer = await sharp(targetPath).rotate(90).toBuffer();
      fs.writeFileSync(targetPath, buffer);
    },
    onDetails: async () => {
      const newThickness = await ask('Thickness', menuState.details.thickness);
      const newFeatures = await ask('Features', menuState.details.features, { isArray: true });
      return {
        thickness: newThickness || menuState.details.thickness,
        features: (newFeatures && newFeatures.length > 0) ? newFeatures : menuState.details.features,
      };
    },
    onSwapSides: async () => {
      // Paths get swapped in the review menu handler
    },
    onManualSelect: async () => {
      // Force interactive selection — override _perfectMatch so matchCard always prompts
      const { product, productVariant } = await selectCard(setData, { ...imageDefaults, _perfectMatch: false });
      let quantity = 0;
      try {
        quantity = await getInventoryQuantity(productVariant);
      } catch {
        // best-effort
      }
      const currentPrices = productVariant.prices ?? setData.category?.metadata?.prices ?? [];
      const pricingResult = await getDefaultPricing(currentPrices, args['allBase']);
      return { product, variant: productVariant, quantity, prices: pricingResult.prices, priceDisplay: pricingResult.display };
    },
  });

  return reviewed;
};

/** Phase 3: Post-review upload & listing — runs on uploadQueue (concurrency 3). */
const finalizeCard = async (reviewed: ReviewMenuState, setData: SetInfo): Promise<void> => {
  const product = reviewed.matchedProduct;
  const productVariant = reviewed.matchedVariant;
  if (!product || !productVariant) {
    throw new Error('No card selected — cannot process');
  }
  if (!productVariant.product) {
    productVariant.product = product;
  }

  // Apply reviewed prices
  productVariant.prices = reviewed.priceMoneyAmounts as MoneyAmount[];

  // Apply reviewed details
  if (!productVariant.metadata) productVariant.metadata = {};
  productVariant.metadata.thickness = reviewed.details.thickness;
  productVariant.metadata.features = reviewed.details.features;

  // Duplicate — increment by 1
  const currentQty = await getInventoryQuantity(productVariant);
  if (currentQty > 0) {
    const newQty = currentQty + 1;
    const inventoryItem = await getInventory(productVariant);
    await updateInventory(inventoryItem, newQty);
    debug(`Duplicate: ${productVariant.product!.title} — quantity ${currentQty} → ${newQty}`);
    markScanned(reviewed.frontPath, reviewed.backPath);
    return;
  }

  // Prepare and upload images
  const images: ProductImage[] = [];
  const frontImage = await prepareImageFile(reviewed.frontPath, productVariant, setData, 1, true);
  if (frontImage) {
    images.push({
      file: frontImage,
      url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.product!.handle}1.jpg}?alt=media`,
    });
  }
  if (reviewed.backPath) {
    const backImage = await prepareImageFile(reviewed.backPath, productVariant, setData, 2, true);
    if (backImage) {
      images.push({
        file: backImage,
        url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.product!.handle}2.jpg}?alt=media`,
      });
    }
  }

  await processUploads(productVariant, images, String(reviewed.quantity));
  markScanned(reviewed.frontPath, reviewed.backPath);
};


const processPair = async (
  front: string,
  back: string,
  imageDefaults: Partial<Product>,
  setData: SetInfo,
  args: ParsedArgs,
) => {
  try {
    const { resizeImageForDisplay } = await import('../image-processing/imageProcessor.js');

    // Clear terminal to free iTerm2's inline image cache and prevent memory bloat
    process.stdout.write('\x1B[2J\x1B[3J\x1B[H');

    try {
      // Try to display the front image using term-img first
      const resizedFront = await resizeImageForDisplay(front);
      const frontImageOutput = await terminalImage(resizedFront, { height: 25 });
      log('  ' + frontImageOutput);
    } catch (error) {
      // If term-img fails, show image info
      log('  📷 [Front image display failed, showing details]');
      log(`     File: ${front.split('/').pop()}`);
      
      // Try to get image dimensions using sharp
      try {
        const sharp = await import('sharp');
        const metadata = await sharp.default(front).metadata();
        log(`     Dimensions: ${metadata.width} x ${metadata.height}`);
        log(`     Format: ${metadata.format}`);
        log(`     Size: ${metadata.size ? (metadata.size / 1024 / 1024).toFixed(2) : 'Unknown'} MB`);
      } catch (sharpError) {
        log('     [Could not read image metadata]');
      }
    }
    
    if (back) {
      log('  ');
      try {
        // Try to display the back image using term-img first
        const resizedBack = await resizeImageForDisplay(back);
        const backImageOutput = await terminalImage(resizedBack, { height: 25 });
        log('  ' + backImageOutput);
      } catch (error) {
        // If term-img fails, show image info
        log('  📷 [Back image display failed, showing details]');
        log(`     File: ${back.split('/').pop()}`);
        
        // Try to get image dimensions using sharp
        try {
          const sharp = await import('sharp');
          const metadata = await sharp.default(back).metadata();
          log(`     Dimensions: ${metadata.width} x ${metadata.height}`);
          log(`     Format: ${metadata.format}`);
          log(`     Size: ${metadata.size ? (metadata.size / 1024 / 1024).toFixed(2) : 'Unknown'} MB`);
        } catch (sharpError) {
          log('     [Could not read image metadata]');
        }
      }
    }

    // Phase 1: Select the card (auto or user-selected)
    const { product, productVariant } = await selectCard(setData, imageDefaults);
    if (!productVariant.product) throw new Error('Must set Product on the Variant before processing');

    // Check backend inventory — if > 0, this is a duplicate, auto-increment
    const currentQty = await getInventoryQuantity(productVariant);
    if (currentQty > 0) {
      const newQty = currentQty + 1;
      const inventoryItem = await getInventory(productVariant);
      await updateInventory(inventoryItem, newQty);
      markScanned(front, back);
      debug(`Duplicate: ${productVariant.product.title} — quantity ${currentQty} → ${newQty}`);
      return { productVariant, quantity: String(newQty), images: [] };
    }

    // Phase 2: New card — ask pricing, quantity
    const { productVariant: pv, quantity } = await getCardDetails(setData, imageDefaults, args, product, productVariant);

    const images: ProductImage[] = [];
    const frontImage = await prepareImageFile(front, pv, setData, 1, args.i || watchModeCropEnabled);
    if (frontImage) {
      images.push({
        file: frontImage,
        url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${pv.product!.handle}1.jpg}?alt=media`,
      });
    }
    if (back) {
      const backImage = await prepareImageFile(back, pv, setData, 2, args.i || watchModeCropEnabled);
      if (backImage) {
        images.push({
          file: backImage,
          url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${pv.product!.handle}2.jpg}?alt=media`,
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      uploadQueue.push(async () => {
        try {
          await processUploads(pv, images, String(quantity));
          resolve();
        } catch (e) {
          reject(e);
          throw e;
        }
      });
    });

    markScanned(front, back);
    return { productVariant: pv, quantity, images };
  } catch (e) {
    console.error(e);
    throw e;
  }
};

const processUploads = async (productVariant: ProductVariant, imageInfo: ProductImage[], quantity: string) => {
  const images = await Promise.all(
    imageInfo.map(async (image, i) => {
      if (!productVariant.product) throw 'Must set Product on the Variant before processing uploads';
      const uploadedFileName: string = `${productVariant.title.replaceAll(' ', '-').replace(/[^a-zA-Z0-9]/g, '')}${i + 1}.jpg`;
      await processImageFile(image.file, uploadedFileName);
      return uploadedFileName;
    }),
  );
  await saveListing(productVariant, images, quantity);
  return productVariant;
};

const processBulk = async (setData: SetInfo, args: ParsedArgs) => {
  if (!setData.products) throw 'Must set products on Set Data before processing bulk listings';

  const { finish, error } = showSpinner('bulk', `Processing Bulk Listings`);
  log('Adding Bulk Listings');
  const saving: Promise<InventoryItemDTO>[] = [];
  try {
    let products = setData.products;
    if (args.numbers) {
      if (args.numbers.includes(',')) {
        const numbers = args.numbers.split(',');
        products = products.filter((p) => numbers.includes(p.metadata?.cardNumber));
      } else if (args.numbers.startsWith('<')) {
        const number = parseInt(args.numbers.replace('<', ''));
        products = products.filter((p) => parseInt(p.metadata?.cardNumber) < number);
      } else if (args.numbers.startsWith('>')) {
        const number = parseInt(args.numbers.replace('>', ''));
        products = products.filter((p) => parseInt(p.metadata?.cardNumber) > number);
      } else {
        products = products.filter((p) => p.metadata?.cardNumber === args.numbers);
      }
      if (products.length === 0) throw new Error(`No products found for ${args.numbers}`);
    }
    products = _.sortBy(products, (p) => {
      let asInt = parseInt(p.metadata?.cardNumber);
      if (isNaN(asInt)) {
        if (setData.metadata?.card_number_prefix) {
          asInt = parseInt(p.metadata?.cardNumber.replace(setData.metadata?.card_number_prefix, ''));
        }
        if (isNaN(asInt)) {
          return p.metadata?.cardNumber;
        }
      }
      return asInt;
    });
    if (args['select-bulk-cards']) {
      type Option = { product: Product; variant: ProductVariant };
      const variants: AskSelectOption<Option>[] = products.reduce((acc: AskSelectOption<Option>[], product) => {
        if (!product.variants) throw new Error('Product has no variants');
        return acc.concat(product.variants?.map((variant) => ({ value: { product, variant }, name: variant.title })));
      }, []);
      const selectOptions = [{ value: 'done', name: 'done' }, ...variants];
      let selected: Option | string | undefined;
      while (selected !== 'done') {
        selected = await ask('Select Variants for Bulk Listings', undefined, { selectOptions });
        if (selected && selected !== 'done') {
          const selectedOption: Option = <Option>selected;
          const createListing = await ask(selectedOption.variant.title, selectedOption.variant.inventory_quantity || 1);
          if (createListing > 0) {
            hasUpdated = true;
            saving.push(saveBulk(selectedOption.product, selectedOption.variant, createListing));
          }
        }
      }
    } else {
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        if (!product.variants) throw new Error('Product has no variants');
        const variants = _.sortBy(product.variants, 'metadata.cardNumber');
        for (let j = 0; j < variants.length; j++) {
          if (!args['inventory'] || variants[j].inventory_quantity > 0) {
            const variant = variants[j];
            let title = variant.title.trim();
            // console.log(`Processing ${title} isBase: ${variant.metadata?.isBase} variants: ${variants.length}`);
            if (variant.metadata?.isBase && variants.length > 1) {
              title = `Has Variations:\n   ${variants
                .filter((v) => !v.metadata?.isBase)
                .map((v) => v.metadata?.variationName)
                .join('\n   ')}\n${chalk.green('?')} ${title}`;
            }
            const createListing = await ask(title, variant.inventory_quantity || undefined);
            if (createListing && createListing !== variant.inventory_quantity) {
              // log(`Creating ${createListing} listings for ${variant.title}`);
              hasUpdated = true;
              saving.push(saveBulk(product, variant, createListing));
            }
          }
        }
      }
    }
    const inventory = await Promise.all(saving);
    finish(`Processed ${inventory.length} Bulk Listings`);
  } catch (e) {
    error(e);
    throw e;
  }
};

// Helper function to check if a variant has stored images
const hasStoredImages = (variant: ProductVariant): boolean => {
  return !!(
    variant.metadata?.frontImage || 
    variant.metadata?.backImage || 
    (variant.metadata?.extraImages && variant.metadata.extraImages.length > 0)
  );
};

export const processPrice = async (setData: SetInfo, args: ParsedArgs) => {
  if (!setData.products) throw 'Must set products on Set Data before processing price updates';

  const { finish, error, update: updateSpinner } = showSpinner('price', `Processing Price Updates`);
  log('Updating Prices and Quantities');
  
  // Create queue for price updates
  const queuePriceUpdates = new Queue({
    results: [],
    autostart: true,
    concurrency: 5, // Process 5 updates concurrently
  });
  
  const updateErrors: Array<{ variant: string; error: Error }> = [];
  
  try {
    let products = setData.products;
    if (args.numbers) {
      if (args.numbers.includes(',')) {
        const numbers = args.numbers.split(',');
        products = products.filter((p) => numbers.includes(p.metadata?.cardNumber));
      } else if (args.numbers.startsWith('<')) {
        const number = parseInt(args.numbers.replace('<', ''));
        products = products.filter((p) => parseInt(p.metadata?.cardNumber) < number);
      } else if (args.numbers.startsWith('>')) {
        const number = parseInt(args.numbers.replace('>', ''));
        products = products.filter((p) => parseInt(p.metadata?.cardNumber) > number);
      } else {
        products = products.filter((p) => p.metadata?.cardNumber === args.numbers);
      }
      if (products.length === 0) throw new Error(`No products found for ${args.numbers}`);
    }
    products = _.sortBy(products, (p) => {
      let asInt = parseInt(p.metadata?.cardNumber);
      if (isNaN(asInt)) {
        if (setData.metadata?.card_number_prefix) {
          asInt = parseInt(p.metadata?.cardNumber.replace(setData.metadata?.card_number_prefix, ''));
        }
        if (isNaN(asInt)) {
          return p.metadata?.cardNumber;
        }
      }
      return asInt;
    });

    // Collect all variants for batch inventory fetching
    const allVariants: ProductVariant[] = [];
    for (const product of products) {
      if (product.variants) {
        allVariants.push(...product.variants);
      }
    }

    // Batch fetch inventory quantities upfront (major performance optimization)
    updateSpinner('Fetching inventory quantities...');
    const inventoryStartTime = Date.now();
    const inventoryQuantityMap = await getInventoryQuantitiesBatch(
      allVariants,
      (message) => updateSpinner(message)
    );
    const inventoryDuration = Date.now() - inventoryStartTime;
    log(`Fetched inventory for ${allVariants.length} variants in ${inventoryDuration}ms`);

    // Cache region IDs upfront to avoid repeated calls
    updateSpinner('Loading region information...');
    const regionStartTime = Date.now();
    const ebayRegionId = await getRegion('ebay');
    const mcpRegionId = await getRegion('MCP');
    const bscRegionId = await getRegion('BSC');
    const sportlotsRegionId = await getRegion('SportLots');
    const regionDuration = Date.now() - regionStartTime;
    log(`Loaded region IDs in ${regionDuration}ms`);

    const commonPricing = await getCommonPricing();
    const bscCommonPrice = commonPricing.find((p) => bscRegionId === p.region_id)?.amount || 25;
    const sportlotsCommonPrice = commonPricing.find((p) => sportlotsRegionId === p.region_id)?.amount || 18;

    // Calculate total variants for progress tracking
    let totalVariants = 0;
    let processedVariants = 0;
    for (const product of products) {
      if (product.variants) {
        totalVariants += product.variants.length;
      }
    }

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      if (!product.variants) throw new Error('Product has no variants');
      const variants = _.sortBy(product.variants, 'metadata.cardNumber');
      for (let j = 0; j < variants.length; j++) {
        const variant = variants[j];
        // Filter: include if inventory mode is off, or inventory > 0, or (-x flag is set and variant has stored images)
        const shouldInclude = !args['inventory'] || 
                             variant.inventory_quantity > 0 || 
                             (args['include-zero-images'] && hasStoredImages(variant));
        if (shouldInclude) {
          processedVariants++;
          
          // Update progress
          updateSpinner(`Processing variant ${processedVariants}/${totalVariants}: ${variant.title}`);
          
          // Get current quantity from batch-fetched map (O(1) lookup instead of API call)
          const currentQuantity = variant.sku ? (inventoryQuantityMap.get(variant.sku) ?? 0) : 0;
          
          // Skip cards with 0 inventory unless -x flag is set and card has stored images
          if (currentQuantity == null || currentQuantity === undefined || currentQuantity < 0) {
            continue; // Skip cards with null, undefined, or negative quantity
          }
          if (currentQuantity === 0) {
            // Allow 0 inventory if -x flag is set and variant has stored images
            if (!args['include-zero-images'] || !hasStoredImages(variant)) {
              continue; // Skip cards with 0 inventory that don't meet the criteria
            }
          }
          
          let title = variant.title.trim();
          if (variant.metadata?.isBase && variants.length > 1) {
            title = `Has Variations:\n   ${variants
              .filter((v) => !v.metadata?.isBase)
              .map((v) => v.metadata?.variationName)
              .join('\n   ')}\n${chalk.green('?')} ${title}`;
          }

          // Get current prices using cached region IDs
          const currentPrices = variant.prices || [];
          const getCurrentPrice = (region: string, regionId: string): number | undefined => {
            const price = currentPrices.find((p) => p.region_id === regionId);
            const amount: number | string | undefined = price?.amount;
            // @ts-expect-error sometimes the backend returns a string for some crazy reason
            if (amount && amount !== 'undefined') {
              return typeof amount === 'number' ? amount : parseInt(amount);
            }
            return undefined;
          };

          // Display card title
          log(`\n${chalk.bold(title)}`);

          // Parse percentage reduction from args (default to 10 if flag provided without value, 0 if flag not provided)
          const priceReductionPercent = args['price'] !== undefined ? (parseFloat(args['price'] as string) || 10) : 0;
          
          // Calculate new prices with percentage reduction, maintaining minimums per platform
          const calculateReducedPrice = (currentPrice: number, minPrice: number): number => {
            if (currentPrice === 0) return minPrice;
            const reducedPrice = Math.floor(currentPrice * (1 - priceReductionPercent / 100));
            return Math.max(reducedPrice, minPrice);
          };

          // Use cached region IDs instead of making API calls
          const currentEbay = getCurrentPrice('ebay', ebayRegionId) || 99;
          const currentMCP = getCurrentPrice('MCP', mcpRegionId) || 100;
          const currentBSC = getCurrentPrice('BSC', bscRegionId) || bscCommonPrice;
          const currentSportLots = getCurrentPrice('SportLots', sportlotsRegionId) || sportlotsCommonPrice;

          const calculatedEbay = calculateReducedPrice(currentEbay, 99);
          const calculatedMCP = calculateReducedPrice(currentMCP, 100);
          const calculatedBSC = calculateReducedPrice(currentBSC, bscCommonPrice);
          const calculatedSportLots = calculateReducedPrice(currentSportLots, sportlotsCommonPrice);

          // Check if current pricing is already common pricing
          const isCommonPricing = currentEbay === 99 && 
                                  currentMCP === 100 && 
                                  currentBSC === bscCommonPrice && 
                                  currentSportLots === sportlotsCommonPrice;

          let pricingChoice: string;
          let newPrices: MoneyAmount[] = currentPrices;

          if (isCommonPricing) {
            // Skip pricing selection if already at common pricing
            log('Common Pricing in use');
            pricingChoice = 'original';
          } else {
            // Show calculated prices
            const reductionText = priceReductionPercent > 0 ? ` (${priceReductionPercent}% reduction)` : '';
            log(`\nCalculated prices${reductionText}:`);
            log(`  eBay: ${currentEbay} → ${calculatedEbay}${calculatedEbay === 99 ? ' (minimum)' : ''}`);
            log(`  MCP: ${currentMCP} → ${calculatedMCP}${calculatedMCP === 100 ? ' (minimum)' : ''}`);
            log(`  BSC: ${currentBSC} → ${calculatedBSC}${calculatedBSC === bscCommonPrice ? ' (minimum)' : ''}`);
            log(`  SportLots: ${currentSportLots} → ${calculatedSportLots}${calculatedSportLots === sportlotsCommonPrice ? ' (minimum)' : ''}`);

            // Ask for pricing option
            const pricingOptions = [
              { value: 'reduced', name: 'Reduced Pricing' },
              { value: 'common', name: 'Common Pricing' },
              { value: 'original', name: 'Original Pricing' },
              { value: 'manual', name: 'Manually Set Prices' },
            ];
            // Default to 'original' for 0-inventory cards with images when -x flag is set
            const defaultPricingChoice = (currentQuantity === 0 && args['include-zero-images'] && hasStoredImages(variant)) 
              ? 'original' 
              : undefined;
            pricingChoice = await ask('Select Pricing Option', defaultPricingChoice, { selectOptions: pricingOptions });
          }

          // Normalize pricingChoice to ensure it's a string (ask returns the value directly)
          pricingChoice = String(pricingChoice || 'original').trim();

          if (pricingChoice === 'reduced') {
            log(`Using reduced pricing: eBay=${calculatedEbay}, MCP=${calculatedMCP}, BSC=${calculatedBSC}, SportLots=${calculatedSportLots}`);
            // Use calculated prices with reduction (using cached region IDs)
            newPrices = [
              { amount: calculatedEbay, region_id: ebayRegionId } as MoneyAmount,
              { amount: calculatedMCP, region_id: mcpRegionId } as MoneyAmount,
              { amount: calculatedBSC, region_id: bscRegionId } as MoneyAmount,
              { amount: calculatedSportLots, region_id: sportlotsRegionId } as MoneyAmount,
            ];
          } else if (pricingChoice === 'common') {
            // Use common/minimum pricing (using cached region IDs)
            newPrices = [
              { amount: 99, region_id: ebayRegionId } as MoneyAmount,
              { amount: 100, region_id: mcpRegionId } as MoneyAmount,
              { amount: bscCommonPrice, region_id: bscRegionId } as MoneyAmount,
              { amount: sportlotsCommonPrice, region_id: sportlotsRegionId } as MoneyAmount,
            ];
          } else if (pricingChoice === 'original') {
            // Use original/current prices (already set above)
            newPrices = currentPrices;
          } else if (pricingChoice === 'manual') {
            // Manually set prices, defaulting to reduced pricing
            const getPrice = async (region: string, defaultPrice: number, minPrice: number): Promise<number> => {
              let price = await ask(`${region} price (min: ${minPrice})`, defaultPrice);
              while (price.toString().indexOf('.') > -1) {
                price = await ask(`${region} price should not have a decimal, did you mean: `, price.toString().replace('.', ''));
              }
              const parsedPrice = parseInt(price);
              if (parsedPrice < minPrice) {
                log(`${chalk.yellow(`Warning: ${region} price ${parsedPrice} is below minimum ${minPrice}. Using minimum.`)}`);
                return minPrice;
              }
              return parsedPrice;
            };

            const manualEbay = await getPrice('eBay', calculatedEbay, 99);
            const manualMCP = await getPrice('MCP', calculatedMCP, 100);
            const manualBSC = await getPrice('BSC', calculatedBSC, bscCommonPrice);
            const manualSportLots = await getPrice('SportLots', calculatedSportLots, sportlotsCommonPrice);

            // Use cached region IDs
            newPrices = [
              { amount: manualEbay, region_id: ebayRegionId } as MoneyAmount,
              { amount: manualMCP, region_id: mcpRegionId } as MoneyAmount,
              { amount: manualBSC, region_id: bscRegionId } as MoneyAmount,
              { amount: manualSportLots, region_id: sportlotsRegionId } as MoneyAmount,
            ];
          } else {
            // Unexpected pricing choice - log warning and use original pricing
            log(`${chalk.yellow(`Warning: Unexpected pricing choice "${pricingChoice}". Using original pricing.`)}`);
            newPrices = currentPrices;
          }

          // Prompt for quantity (currentQuantity already fetched above)
          const newQuantity = await ask('Quantity', currentQuantity || undefined, {
            validate: (v) => v === '' || !isNaN(Number(v)) ? true : 'Must be a number',
          });

          // Update prices and quantity if changed
          // Compare new prices with current prices to detect changes (using cached region IDs)
          const getNewPrice = (regionId: string): number => {
            const price = newPrices.find((p) => p.region_id === regionId);
            return price?.amount || 0;
          };
          const newEbayAmount = getNewPrice(ebayRegionId);
          const newMCPAmount = getNewPrice(mcpRegionId);
          const newBSCAmount = getNewPrice(bscRegionId);
          const newSportLotsAmount = getNewPrice(sportlotsRegionId);

          const pricesChanged = pricingChoice !== 'original' && (
            newEbayAmount !== currentEbay ||
            newMCPAmount !== currentMCP ||
            newBSCAmount !== currentBSC ||
            newSportLotsAmount !== currentSportLots
          );
          const parsedQuantity = Number(newQuantity);
          const validQuantity = newQuantity != null && newQuantity !== '' && !isNaN(parsedQuantity);
          const quantityChanged = validQuantity && parsedQuantity !== currentQuantity;

          if (pricesChanged || quantityChanged) {
            hasUpdated = true;
            const variantTitle = variant.title;
            
            // Add price update to queue
            if (pricesChanged) {
              queuePriceUpdates.push(async () => {
                try {
                  await updatePrices(product.id, variant.id, newPrices);
                } catch (e) {
                  updateErrors.push({ variant: variantTitle, error: e as Error });
                  log(`${chalk.red(`Error updating prices for ${variantTitle}:`)} ${e}`);
                  throw e;
                }
              });
            }
            
            // Add quantity update to queue
            if (quantityChanged) {
              queuePriceUpdates.push(async () => {
                try {
                  const inventoryItem = await getInventory(variant);
                  await updateInventory(inventoryItem, parsedQuantity);
                } catch (e) {
                  updateErrors.push({ variant: variantTitle, error: e as Error });
                  log(`${chalk.red(`Error updating quantity for ${variantTitle}:`)} ${e}`);
                  throw e;
                }
              });
            }
          }
        }
      }
    }
    
    // Wait for queue to finish - ensure it completes
    const initialQueueLength = queuePriceUpdates.length;
    if (initialQueueLength > 0) {
      updateSpinner(`Waiting for ${initialQueueLength} price updates to complete...`);
      try {
        await new Promise<void>((resolve) => {
          let resolved = false;
          let checkInterval: NodeJS.Timeout | null = null;
          let timeoutHandle: NodeJS.Timeout | null = null;
          
          const cleanup = () => {
            if (!resolved) {
              resolved = true;
              try {
                queuePriceUpdates.removeEventListener('end', onEnd);
                queuePriceUpdates.removeEventListener('error', onError);
              } catch (e) {
                // Ignore cleanup errors
              }
              // Clear interval and timeout to prevent them from keeping the process alive
              if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
              }
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
            }
          };
          
          const onEnd = () => {
            cleanup();
            resolve();
          };
          
          const onError = (e: any) => {
            cleanup();
            const errorMsg = e.detail?.error || e;
            log(`${chalk.red('Queue error:')} ${errorMsg}`);
            // Still resolve to continue processing - errors are already logged in updateErrors
            resolve();
          };
          
          queuePriceUpdates.addEventListener('end', onEnd);
          queuePriceUpdates.addEventListener('error', onError);
          
          // Fallback: check periodically if queue is done (in case event doesn't fire)
          checkInterval = setInterval(() => {
            if (queuePriceUpdates.length === 0 && !resolved) {
              cleanup();
              resolve();
            }
          }, 100);
          
          // Safety timeout - resolve after 5 minutes even if queue isn't done
          timeoutHandle = setTimeout(() => {
            if (!resolved) {
              cleanup();
              log(`${chalk.yellow('Warning:')} Queue timeout - forcing completion`);
              resolve();
            }
          }, 300000);
        });
      } catch (e) {
        log(`${chalk.yellow('Warning:')} Error waiting for queue: ${e}`);
        // Continue anyway - errors are already logged
      }
    }
    
    // Print any errors that occurred
    if (updateErrors.length > 0) {
      log(`\n${chalk.red(`Errors occurred during ${updateErrors.length} update(s):`)}`);
      for (const err of updateErrors) {
        log(`${chalk.red(`  ${err.variant}:`)} ${err.error.message || err.error}`);
      }
    }
    
    const totalUpdates = queuePriceUpdates.results?.length || 0;
    finish(`Processed ${totalUpdates} Price Updates${updateErrors.length > 0 ? ` (${updateErrors.length} errors)` : ''}`);
  } catch (e) {
    error(e);
    throw e;
  }
};

export async function processSet(setData: SetInfo, files: string[] = [], args: ParsedArgs, inputDirectory?: string) {
  const count = files.length || 0 / 2;
  let current = 0;
  hasUpdated = false;
  cardProcessorQueue.addEventListener('success', () => {
    current++;
    debug(`Card processor progress: ${current}/${count}`);
  });

  debug('Prepping queues for AI');
  try {
    let i = 0;
    // log(setData);
    // log(files);

    setData.products = await getProducts(setData.category.id);

    if (setData.products.length === 0) {
      await buildSet(setData);
      setData.products = await getProducts(setData.category.id);
    }

    // Handle price mode - skip image processing
    if (args['price'] !== undefined) {
      debug('Processing price updates');
      await processPrice(setData, args);
      debug('Kicking off set processing');
      if (!args['no-sync']) {
        await startSync(setData.category.id);
      }
      debug('Completed set processing');
      return;
    }

    if (args.countCardsFirst) {
      const { finish } = showSpinner('count-cards', `Counting Cards`);
      await processBulk(setData, args);
      await ask('Count Collection Complete! Press Enter to continue');
      const input_directory = await getInputs(args);
      if (input_directory !== 'input/bulk/') {
        files = await getFiles(input_directory);
      }
      finish();
    }

    // Load previously scanned files to skip on restart
    if (inputDirectory) {
      loadScannedFiles(inputDirectory);
      const beforeCount = files.length;
      files = files.filter((f) => !isFileScanned(f));
      const skipped = beforeCount - files.length;
      if (skipped > 0) {
        log(chalk.yellow(`Skipped ${skipped} already-scanned file(s)`));
      }
    }

    let hasQueueError = false;
    const watchForError = (name: string, queue: Queue) =>
      queue.addEventListener('error', (e) => {
        hasQueueError = true;
        log(`${name} Queue error: ${e.detail.error}`, e);
        cardProcessorQueue.stop();
        uploadQueue.stop();
        throw new Error('Queue Error');
      });
    watchForError('Card Processor', cardProcessorQueue);
    watchForError('Upload', uploadQueue);

    // Collect per-item promises that resolve when the ENTIRE chain
    // (readImage → gatherData → imageFiles) completes for each pair.
    // This avoids the race condition where queue 'end' events fire
    // prematurely when a downstream queue temporarily drains before
    // all upstream items have been pushed to it.
    const allJobPromises: Promise<void>[] = [];
    let itemsPushed = 0;

    // Non-watch mode: pair files sequentially
    if (!args['watch']) {
      while (i < files.length - 1) {
        const imgA = files[i++];
        let imgB: string = imgA;
        if (i < files.length) {
          imgB = files[i++];
        }
        const jobPromise = new Promise<void>((resolve, reject) => {
          cardProcessorQueue.push(async () => {
            try {
              await preProcessPair(imgA, imgB, setData, args);
              resolve();
            } catch (e) {
              reject(e);
              throw e;
            }
          });
        });
        allJobPromises.push(jobPromise);
        itemsPushed++;
      }
    }

    // Watch mode: feed ALL files (initial + new) through smart matching
    // so every card gets a confirmSide prompt.
    if (args['watch'] && inputDirectory && !hasQueueError) {
      const { watchWithSmartMatching } = await import('../utils/watchDirectory.js');
      const { extractSingleCardInfo } = await import('../image-processing/card-extractor.js');
      const { extractTextFromImage } = await import('../image-processing/ocr-extractor.js');
      const { orientAndClassifyCards: orientSingle } = await import('../image-processing/card-cropper-wrapper.js');
      const { cropImage } = await import('../image-processing/imageProcessor.js');
      // Don't mark initial files as "known" — let the watcher process them
      const knownFiles = new Set<string>();

      // Set up early cropping: crop images immediately on detection before OCR
      const cropOutputDir = path.resolve(inputDirectory, 'crop');
      fs.mkdirSync(cropOutputDir, { recursive: true });
      watchModeCropEnabled = true;

      // Forward ref so onPairReady can call watcher.reAddToPool after the
      // initializer finishes. The closure is only invoked later when pairs match.
      let watcher!: import('../utils/watchDirectory.js').DirectoryWatcher;
      watcher = watchWithSmartMatching({
        directory: inputDirectory,
        knownFiles,
        scannedFiles,
        initialFiles: files,

        // ── Automated callbacks (intake queue, concurrency 3) ─────────────
        autoCrop: async (imagePath: string) => {
          const croppedPath = path.join(cropOutputDir, path.basename(imagePath));

          try {
            // Non-interactive: auto-accept first successful crop, skip manual fallback
            await cropImage(imagePath, null, cropOutputDir, croppedPath, false, false, true);
          } catch {
            return null; // crop failed — review queue will handle it
          }

          // Track original name for scanned-file bookkeeping
          cropOriginalNames.set(path.basename(croppedPath), path.basename(imagePath));
          return croppedPath;
        },
        autoOrient: async (imagePath: string) => {
          const results = await orientSingle([imagePath]);
          return results.get(imagePath)?.text_detection_count ?? 0;
        },
        classifyAndExtract: async (imagePath: string, textDetectionCount: number) => {
          // Extract card info + front/back classification via vision AI
          const extracted = await extractSingleCardInfo(imagePath);

          return {
            path: imagePath,
            side: extracted.side ?? (textDetectionCount >= 5 ? 'back' : 'front'),
            player: extracted.player,
            team: extracted.team,
            cardNumber: extracted.card_number,
            textDetectionCount,
            timestamp: Date.now(),
          };
        },

        // ── OCR fallback for pool matching ─────────────────────────────
        ocrResolver: async (imagePath: string) => {
          const result = await extractTextFromImage(imagePath);
          if (result.error || !result.text) return null;
          return {
            text: result.text,
            words: result.words ?? [],
          };
        },

        // ── Non-interactive review callbacks ─────────────────────────────
        // All user interaction now happens in the review menu after pair matching.
        // These callbacks auto-accept the automated results.
        confirmCrop: async (_originalPath: string, croppedPath: string | null) => {
          // Auto-accept the crop — user can re-crop via 'c' in the review menu
          return croppedPath ?? _originalPath;
        },
        confirmRotation: async (_imagePath: string) => {
          // Auto-accept orientation — already handled by autoOrient
        },
        confirmPlayer: async (_imagePath, detectedPlayer) => {
          // Auto-accept detected player — user can override via 'm' in review menu
          return detectedPlayer;
        },
        confirmSide: async (_imagePath, detectedSide) => {
          // Auto-accept detected side — user can swap via 's' in review menu
          return detectedSide;
        },
        renderCardPreview: async (imagePath: string) => {
          try {
            const imgOutput = await terminalImage(imagePath, { height: 10 });
            return '    ' + imgOutput;
          } catch {
            // best-effort — filename already shown by caller
          }
        },
        onResolvePool: async (cards) => {
          // This callback is invoked from inside the UI-queue waiting task, which
          // means we already own the UI thread for the entire walk. Inner ask()
          // calls run inline (reentrant via uiTaskActive) — no per-card queueing,
          // no risk of interleaving with a review menu.
          const updatedCards: typeof cards = [];
          for (const card of cards) {
            // eslint-disable-next-line no-console
            console.log('');
            try {
              const imgOutput = await terminalImage(card.path, { height: 15 });
              process.stdout.write('  ' + imgOutput + '\n');
            } catch {
              // eslint-disable-next-line no-console
              console.log(chalk.dim(`  [Image: ${path.basename(card.path)}]`));
            }
            // eslint-disable-next-line no-console
            console.log(chalk.cyan(`  Current: side=${card.side}, player=${card.player ?? '(none)'}, team=${card.team ?? '(none)'}, #${card.cardNumber ?? '(none)'}`));

            const playerAnswer = await ask('Player name', card.player);
            const sideAnswer = await ask('Side', card.side, {
              selectOptions: [
                { name: 'front', value: 'front' },
                { name: 'back', value: 'back' },
              ],
            });

            updatedCards.push({
              ...card,
              player: playerAnswer || null,
              side: sideAnswer as 'front' | 'back',
            });
          }
          return updatedCards;
        },
        onSkip: (imagePath) => {
          markScanned(imagePath, imagePath);
        },
        onPairReady: async (front, back, match) => {
          // Build pool priors from the match — merge front+back extraction data.
          // Prefer front for player (usually has the name), back for cardNumber.
          const priors: PoolPriors = {
            player: match.front.player ?? match.back.player,
            team: match.front.team ?? match.back.team,
            cardNumber: match.front.cardNumber ?? match.back.cardNumber,
          };
          const jobPromise = new Promise<void>((resolve, reject) => {
            // Phase 1: Automated card identification (concurrency 3).
            // The queue slot is released as soon as buildCardState finishes
            // so new cards can start processing while earlier ones wait for
            // user review.
            cardProcessorQueue.push(async () => {
              try {
                const state = await buildCardState(front, back, setData, args, priors);
                // Detach review+upload so the processor slot is freed.
                // resolve/reject are captured by the closure and called when
                // the full chain completes.
                void (async () => {
                  try {
                    // Phase 2: Interactive review on the UI queue (concurrency 1).
                    // submitUITask automatically wakes any idling waiting task.
                    // If the session is already complete, the task is dropped and
                    // the returned promise resolves with undefined — we treat that
                    // as "skip finalize" so the job promise still resolves.
                    const reviewed = await submitUITask('review', async () => reviewCard(state));
                    if (reviewed === undefined) {
                      resolve();
                      return;
                    }
                    if (reviewed.rejected) {
                      // User rejected one side — mark only that scan as scanned
                      // (so the watcher doesn't re-ingest it) and put the kept
                      // side back into the pool so a fresh rescan pairs with it.
                      // Use the *current* menuState paths for the kept side — the
                      // user may have re-cropped or rotated it in the menu, and
                      // match.front/back still hold the stale intake-time path.
                      const rejectedPath = reviewed.rejected === 'front' ? reviewed.frontPath : reviewed.backPath;
                      markScanned(rejectedPath, rejectedPath);
                      const sourceCard = reviewed.rejected === 'front' ? match.back : match.front;
                      const currentKeptPath = reviewed.rejected === 'front' ? reviewed.backPath : reviewed.frontPath;
                      const keptCard: UnmatchedCard = { ...sourceCard, path: currentKeptPath, timestamp: Date.now() };
                      log(chalk.yellow(`Rejected ${reviewed.rejected} — returned ${keptCard.side} to pool, waiting for rescan`));
                      await watcher.reAddToPool(keptCard);
                      resolve();
                      return;
                    }
                    // Phase 3: Upload & listing (concurrency 3) — background.
                    uploadQueue.push(async () => {
                      try {
                        await finalizeCard(reviewed, setData);
                        resolve();
                      } catch (e) {
                        // Surface upload errors to the user via the UI queue.
                        submitUITask('log', async () => {
                          // eslint-disable-next-line no-console
                          console.log(chalk.red(`Upload failed: ${e instanceof Error ? e.message : String(e)}`));
                        });
                        reject(e);
                        throw e;
                      }
                    });
                  } catch (e) { reject(e); }
                })();
              } catch (e) { reject(e); throw e; }
            });
          });
          allJobPromises.push(jobPromise);
          itemsPushed++;
          // Return jobPromise so the watcher can track when the full chain completes,
          // but the intake queue in watchDirectory does NOT await it.
          return jobPromise;
        },
      });

      // Wait for initial files to finish, then show idle prompt
      if (itemsPushed > 0) {
        debug('Processing initial cards');
        try {
          await Promise.all(allJobPromises);
          debug('Initial cards processed');
        } catch (e) {
          hasQueueError = true;
          debug(`Initial cards processing failed: ${e instanceof Error ? e.message : String(e)}`);
          log(chalk.red(`Initial cards processing failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      }

      if (!hasQueueError) {
        // Wait for the intake queue to finish processing initial files before
        // starting the UI waiting loop. startUILoop registers this watcher's
        // waiting-task body with the shared UI queue and pushes the first
        // iteration; the UI queue self-perpetuates via its 'end' handler.
        await watcher.intakeIdlePromise;
        watcher.startUILoop();
        await watcher.completionPromise;
      }

      // Always stop the watcher
      watcher.stop();

      // Drain any jobs that were added by the watcher
      if (allJobPromises.length > 0 && !hasQueueError) {
        log(chalk.yellow('Completing... waiting for remaining cards to finish processing.'));
        try {
          await Promise.all(allJobPromises);
        } catch (e) {
          hasQueueError = true;
        }
      }
    }

    if (!args['watch'] && itemsPushed > 0 && !hasQueueError) {
      debug('Waiting for all cards to finish processing');
      try {
        await Promise.all(allJobPromises);
        debug('All cards finished processing');
      } catch (e) {
        hasQueueError = true;
        debug(`Queue errored: ${e instanceof Error ? e.message : String(e)}`);
        log(chalk.red(`Queue errored: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (hasQueueError) {
      debug('Queue errored');
      log(chalk.red('Queue errored'));
    }

    // If Ctrl+C was pressed, skip bulk/sync and exit gracefully
    if (wasCtrlCPressed()) {
      debug('Ctrl+C pressed — exiting after queue drain');
      return;
    }

    //write the output
    if (!hasQueueError) {
      if (args['select-bulk-cards']) {
        log('select-bulk-cards is not yet implemented');
      }
      if (!args.countCardsFirst && args['price'] === undefined) {
        const addBulk = args.bulk || (await ask('Add Bulk Listings?', listings.length === 0));
        if (addBulk) {
          debug('Processing bulk listings');
          setData.products = await getProducts(setData.category.id);
          await processBulk(setData, args);
        }
      }
      debug('Kicking off set processing');
      if (!args['no-sync'] && (!args['inventory'] || hasUpdated)) {
        await startSync(setData.category.id);
      }
    }
    debug('Completed set processing');
  } catch (error) {
    debug(`processSet error: ${error instanceof Error ? error.message : String(error)}`);
    log(chalk.red(`processSet error: ${error instanceof Error ? error.message : String(error)}`));
    throw error;
  }
}


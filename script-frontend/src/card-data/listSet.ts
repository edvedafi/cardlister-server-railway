import { useSpinners } from '../utils/spinners';
import chalk from 'chalk';
import Queue from 'queue';
import { getCardData, saveBulk, saveListing } from './cardData';
import terminalImage from 'term-img';
import { prepareImageFile } from '../image-processing/imageProcessor.js';
import { getProducts, startSync, updatePrices, updateInventory, getInventory, getInventoryQuantity, getRegion, getInventoryQuantitiesBatch } from '../utils/medusa';
import { ask, type AskSelectOption } from '../utils/ask';
import type { SetInfo } from '../models/setInfo';
import type { ProductImage } from '../models/cards';
import { processImageFile } from '../listing-sites/firebase';
import imageRecognition from './imageRecognition';
import type { InventoryItemDTO, Product, ProductVariant, MoneyAmount } from '@medusajs/client-types';
import { buildSet } from './setData';
import _ from 'lodash';
import type { ParsedArgs } from 'minimist';
import { getFiles, getInputs } from '../utils/inputs';
import { getCommonPricing } from './pricing';

const { showSpinner, log } = useSpinners('list-set', chalk.cyan);

const listings: ProductVariant[] = [];
const queueReadImage = new Queue({
  results: [],
  autostart: true,
  concurrency: 3,
});
const queueGatherData = new Queue({
  results: [],
  autostart: true,
  concurrency: 1,
});
const queueImageFiles = new Queue({
  results: listings,
  autostart: true,
  concurrency: 3,
});

let hasUpdated = false;

const preProcessPair = async (front: string, back: string, setData: SetInfo, args: ParsedArgs) => {
  const { update, finish, error } = showSpinner(`singles-preprocess-${front}`, `Pre-Processing ${front}/${back}`);
  try {
    update(`Getting image recognition data`);
    const imageDefaults = await imageRecognition(front, back, setData);
    update(`Queueing next step`);
    queueGatherData.push(() => processPair(front, back, imageDefaults, setData, args));
    finish();
  } catch (e) {
    error(e);
    throw e;
  }
};

const processPair = async (
  front: string,
  back: string,
  imageDefaults: Partial<Product>,
  setData: SetInfo,
  args: ParsedArgs,
) => {
  try {
    try {
      // Try to display the front image using term-img first
      const frontImageOutput = await terminalImage(front, { height: 25 });
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
        const backImageOutput = await terminalImage(back, { height: 25 });
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

    const { productVariant, quantity } = await getCardData(setData, imageDefaults, args);
    if (!productVariant.product) throw new Error('Must set Product on the Variant before processing');

    const images: ProductImage[] = [];
    const frontImage = await prepareImageFile(front, productVariant, setData, 1, args.i);
    if (frontImage) {
      images.push({
        file: frontImage,
        url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.product.handle}1.jpg}?alt=media`,
      });
    }
    if (back) {
      const backImage = await prepareImageFile(back, productVariant, setData, 2, args.i);
      if (backImage) {
        images.push({
          file: backImage,
          url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.product.handle}2.jpg}?alt=media`,
        });
      }
    }

    queueImageFiles.push(() => processUploads(productVariant, images, quantity));

    return { productVariant, quantity, images };
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
        products = products.filter((p) => {
          console.log(`Checking ${p.metadata?.cardNumber} in ${numbers}`);
          return numbers.includes(p.metadata?.cardNumber);
        });
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
        products = products.filter((p) => {
          console.log(`Checking ${p.metadata?.cardNumber} in ${numbers}`);
          return numbers.includes(p.metadata?.cardNumber);
        });
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
        if (!args['inventory'] || variants[j].inventory_quantity > 0) {
          const variant = variants[j];
          processedVariants++;
          
          // Update progress
          updateSpinner(`Processing variant ${processedVariants}/${totalVariants}: ${variant.title}`);
          
          // Get current quantity from batch-fetched map (O(1) lookup instead of API call)
          const currentQuantity = variant.sku ? (inventoryQuantityMap.get(variant.sku) ?? 0) : 0;
          if (currentQuantity == null || currentQuantity === undefined || currentQuantity <= 0) {
            continue; // Skip cards with 0, null, undefined, or negative quantity
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

          // Parse percentage reduction from args (default to 0 if not provided)
          const priceReductionPercent = args['price'] ? parseFloat(args['price'] as string) || 0 : 0;
          
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
            pricingChoice = await ask('Select Pricing Option', undefined, { selectOptions: pricingOptions });
          }

          if (pricingChoice === 'reduced') {
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
          }

          // Prompt for quantity (currentQuantity already fetched above)
          const newQuantity = await ask('Quantity', currentQuantity || undefined);

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
          const quantityChanged = newQuantity !== currentQuantity;

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
                  await updateInventory(inventoryItem, newQuantity);
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

export async function processSet(setData: SetInfo, files: string[] = [], args: ParsedArgs) {
  const {
    update: updateSpinner,
    finish: finishSpinner,
    error: errorSpinner,
  } = showSpinner('list-set', `Processing Images`);
  const count = files.length || 0 / 2;
  let current = 0;
  hasUpdated = false;
  queueReadImage.addEventListener('success', () => {
    current++;
    updateSpinner(`${current}/${count}`);
  });

  updateSpinner('Prepping Queues for AI');
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
    if (args['price']) {
      updateSpinner('Processing Price Updates');
      await processPrice(setData, args);
      updateSpinner(`Kickoff Set Processing`);
      if (!args['no-sync']) {
        await startSync(setData.category.id);
      }
      finishSpinner('Completed Set Processing');
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

    while (i < files.length - 1) {
      const front = files[i++];
      let back: string;
      if (i < files.length) {
        back = files[i++];
      }
      queueReadImage.push(() => preProcessPair(front, back, setData, args));
    }

    let hasQueueError = false;
    const watchForError = (name: string, queue: Queue) =>
      queue.addEventListener('error', (e) => {
        hasQueueError = true;
        log(`${name} Queue error: ${e.detail.error}`, e);
        queueReadImage.stop();
        queueGatherData.stop();
        queueImageFiles.stop();
        throw new Error('Queue Error');
      });
    watchForError('Read', queueReadImage);
    watchForError('Gather', queueGatherData);
    watchForError('Process Images', queueImageFiles);

    const { finish: finishImage, error: errorImage } = showSpinner('image', `Waiting for Image Queue to finish`);
    if (queueReadImage.length > 0 && !hasQueueError) {
      await new Promise((resolve) => queueReadImage.addEventListener('end', resolve));
      finishImage();
    } else if (hasQueueError) {
      errorImage(`Image Queue errored`);
    } else {
      finishImage();
    }

    const { finish: finishData, error: errorData } = showSpinner('data', `Waiting for Data Queue to finish`);
    if (queueGatherData.length > 0 && !hasQueueError) {
      await new Promise((resolve) => queueGatherData.addEventListener('end', resolve));
      finishData();
    } else if (hasQueueError) {
      errorData(`Data Queue errored`);
    } else {
      finishData();
    }

    const { finish: finishFile, error: errorFile } = showSpinner('file', `Waiting for File Queue to finish`);
    if (queueImageFiles.length > 0 && !hasQueueError) {
      await new Promise((resolve) => queueImageFiles.addEventListener('end', resolve));
      finishFile();
    } else if (hasQueueError) {
      errorFile(`File Queue errored`);
    } else {
      finishFile();
    }

    //write the output
    if (hasQueueError) {
      errorSpinner(hasQueueError);
    } else {
      if (args['select-bulk-cards']) {
        log('select-bulk-cards is not yet implemented');
      }
      if (!args.countCardsFirst) {
        const addBulk = args.bulk || (await ask('Add Bulk Listings?', listings.length === 0));
        if (addBulk) {
          updateSpinner(`Process Bulk`);
          setData.products = await getProducts(setData.category.id);
          await processBulk(setData, args);
        }
      }
      updateSpinner(`Kickoff Set Processing`);
      if (!args['no-sync'] && (!args['inventory'] || hasUpdated)) {
        await startSync(setData.category.id);
      }
    }
    finishSpinner('Completed Set Processing');
  } catch (error) {
    errorSpinner(error);
  }
}


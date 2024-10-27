import { useSpinners } from '../utils/spinners';
import chalk from 'chalk';
import Queue from 'queue';
import { getCardData, saveBulk, saveListing } from './cardData';
import terminalImage from 'terminal-image';
import { prepareImageFile } from '../image-processing/imageProcessor.js';
import { getProducts, startSync } from '../utils/medusa';
import { ask, type AskSelectOption } from '../utils/ask';
import type { SetInfo } from '../models/setInfo';
import type { ProductImage } from '../models/cards';
import { processImageFile } from '../listing-sites/firebase';
import imageRecognition from './imageRecognition';
import type { InventoryItemDTO, Product, ProductVariant } from '@medusajs/client-types';
import { buildSet } from './setData';
import _ from 'lodash';
import type { ParsedArgs } from 'minimist';
import { getInputs } from '../utils/inputs';

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
    log('  ' + (await terminalImage.file(front, { height: 25 })));
    if (back) {
      log('  ');
      log('  ' + (await terminalImage.file(back, { height: 25 })));
    }

    const { productVariant, quantity } = await getCardData(setData, imageDefaults, args);
    if (!productVariant.product) throw new Error('Must set Product on the Variant before processing');

    const images: ProductImage[] = [];
    const frontImage = await prepareImageFile(front, productVariant, setData, 1);
    if (frontImage) {
      images.push({
        file: frontImage,
        url: `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${productVariant.product.handle}1.jpg}?alt=media`,
      });
    }
    if (back) {
      const backImage = await prepareImageFile(back, productVariant, setData, 2);
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
      const uploadedFileName: string = `${productVariant.product.handle}${i + 1}.jpg`;
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
    }
    if (products.length === 0) throw new Error(`No products found for ${args.numbers}`);
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
          if (createListing > 0) {
            saving.push(saveBulk(product, variant, createListing));
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

export async function processSet(setData: SetInfo, files: string[] = [], args: ParsedArgs) {
  const {
    update: updateSpinner,
    finish: finishSpinner,
    error: errorSpinner,
  } = showSpinner('list-set', `Processing Images`);
  const count = files.length || 0 / 2;
  let current = 0;
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

    if (args.countCardsFirst) {
      const { finish } = showSpinner('count-cards', `Counting Cards`);
      await processBulk(setData, args);
      await ask('Count Collection Complete! Press Enter to continue');
      files = await getInputs(args);
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
      await startSync(setData.category.id);
    }
    finishSpinner('Completed Set Processing');
  } catch (error) {
    errorSpinner(error);
  }
}

import dotenv from 'dotenv';
import 'zx/globals';
import { type UpdateSpinner, useSpinners } from './utils/spinners';
import { clearBSC, shutdownBuySportsCards } from './old-scripts/bsc';
import { parseArgs } from './utils/parseArgs';
import { findSet } from './card-data/setData';
import { fixVariants, getProducts, updateCategory } from './utils/medusa';
import { cleanFeatures, setAllPricesToCommons } from './card-data/cardData';
import type { Product, ProductCategory } from '@medusajs/client-types';

const args = parseArgs(
  {
    string: ['y'],
    boolean: ['b', 'i', 'c', 'f'],
    alias: {
      y: 'year',
      b: 'bsc',
      i: 'images',
      c: 'commons',
      f: 'features',
    },
  },
  {
    year: 'Year',
    images: 'Fix images for all products',
    bsc: 'Remove all cards from year onBuySportsCards',
    commons: 'Set an entire set to common card pricing',
    features: 'Ensure features is a proper array on all products',
  },
);

$.verbose = false;

dotenv.config();

const { showSpinner } = useSpinners('Sync', chalk.cyanBright);
const { update, finish, error } = showSpinner('top-level', 'Running Fixes');

let isShuttingDown = false;
const shutdown = async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    await Promise.all([shutdownBuySportsCards()]);
  }
};

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
  process.on(
    signal,
    async () =>
      await shutdown().then(() => {
        process.exit();
      }),
  ),
);

const processByCategory = (work: (products: Product[]) => Promise<void>) => {
  const processCategory = async (category: ProductCategory) => {
    update(`Cleaning ${category.name}`);
    if (category.category_children.length > 0) {
      for (const child of category.category_children) {
        await processCategory(child);
      }
    } else {
      const products = await getProducts(category.id);
      update(category.name);
      await work(products);
    }
  };
  return processCategory;
};

try {
  if (args.images) {
    update('Product Images');
    const set = await findSet({ allowParent: true });
    update(set.category.name);
    await fixVariants(set.category.id);
  }
  if (args.commons) {
    update('Commons');
    const set = await findSet({ allowParent: true });
    update(set.category.name);
    update('Getting Products');
    const products = await getProducts(set.category.id);
    update('Setting Prices');
    await setAllPricesToCommons(products);
    update('Price set complete');
  }
  if (args.b) {
    update(`BuySportsCards [${args.y}]`);
    if (args.y.indexOf('-') > -1) {
      const [start, end] = args.y.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        update(`BuySportsCards [${i}]`);
        await clearBSC(`${i}`);
      }
    } else {
      await clearBSC(args.y);
    }
  }
  if (args.features) {
    update('Cleaning Features');
    const processor = processByCategory(cleanFeatures);
    const set = await findSet({ allowParent: true });
    await processor(set.category);
  }
} catch (e) {
  error(e);
} finally {
  finish();
  await shutdown();
  process.exit();
}

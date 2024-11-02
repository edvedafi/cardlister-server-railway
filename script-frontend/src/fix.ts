import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { clearBSC, shutdownBuySportsCards } from './old-scripts/bsc';
import { parseArgs } from './utils/parseArgs';
import { findSet } from './card-data/setData';
import { fixVariants, getProducts } from './utils/medusa';
import { setAllPricesToCommons } from './card-data/cardData';

const args = parseArgs(
  {
    string: ['y'],
    boolean: ['b', 'i', 'c'],
    alias: {
      y: 'year',
      b: 'bsc',
      i: 'images',
      c: 'commons',
    },
  },
  {
    year: 'Year',
    images: 'Fix images for all products',
    bsc: 'Remove all cards from year onBuySportsCards',
    commons: 'Set an entire set to common card pricing',
  },
);

$.verbose = false;

dotenv.config();

const { showSpinner, log } = useSpinners('Sync', chalk.cyanBright);

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

// initializeFirebase();

const { update, finish, error } = showSpinner('top-level', 'Running Fixes');
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
  finish();
} catch (e) {
  error(e);
} finally {
  await shutdown();
  // process.exit();
}

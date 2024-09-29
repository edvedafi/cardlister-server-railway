import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { clearBSC, shutdownBuySportsCards } from './old-scripts/bsc';
import { parseArgs } from './utils/parseArgs';
import { findSet } from './card-data/setData';
import { fixVariants } from './utils/medusa';

const args = parseArgs(
  {
    string: ['y'],
    boolean: ['b', 'p'],
    alias: {
      y: 'year',
      b: 'bsc',
      p: 'product',
    },
  },
  {
    year: 'Year',
    product: 'Fix images for all products',
    bsc: 'Remove all cards from year onBuySportsCards',
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
  if (args.p) {
    update('Products');
    const set = await findSet({ allowParent: true });
    update(set.category.name);
    await fixVariants(set.category.id);
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

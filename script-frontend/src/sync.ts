import dotenv from 'dotenv';
import 'zx/globals';
import { shutdownSportLots } from './listing-sites/sportlots-adapter';
import { useSpinners } from './utils/spinners';
import { buildSet, findSet, updateSetDefaults } from './card-data/setData';
import initializeFirebase from './utils/firebase';
import { deleteCardsFromSet, getCategory, startSync, updateCategory } from './utils/medusa';
import { ask } from './utils/ask';
import { checkbox } from '@inquirer/prompts';
import { parseArgs } from './utils/parseArgs';
import type { ProductCategory } from '@medusajs/client-types';

const args = parseArgs(
  {
    boolean: ['d', 's'],
    string: ['o', 'c'],
    alias: {
      d: 'delete',
      o: 'only',
      s: 'select',
      c: 'category',
    },
  },
  {
    d: 'Delete records from Medusa',
    o: 'Only sync selected platforms. Platforms: sportlots(sl), bsc, ebay, mcp',
    s: 'Select platforms to sync',
    c: 'Category to sync',
  },
);

$.verbose = false;

dotenv.config();

const { log } = useSpinners('Sync', chalk.cyanBright);

let isShuttingDown = false;
const shutdown = async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    await Promise.all([shutdownSportLots()]);
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

initializeFirebase();

async function sync(category: ProductCategory) {
  if (args.o) {
    await startSync(category.id, args.o.split(','));
  } else if (!args.s && (await ask(`Sync All listing from ${category.name}?`, true))) {
    await startSync(category.id, args.o?.split(','));
  } else {
    const answers = await checkbox({
      message: 'Select Platforms to Sync',
      choices: [
        {
          name: 'SportLots',
          value: 'sportlots',
          checked: args.only?.indexOf('sportlots') > -1 || args.only?.indexOf('sl') > -1,
        },
        { name: 'BuySportsCards', value: 'bsc', checked: args.only?.indexOf('bsc') > -1 },
        { name: 'ebay', value: 'ebay', checked: args.only?.indexOf('ebay') > -1 },
        { name: 'MyCardPost', value: 'mcp', checked: args.only?.indexOf('mcp') > -1 },
        { name: 'MySlabs', value: 'myslabs', checked: args.only?.indexOf('myslabs') > -1 },
      ],
    });
    if (answers && answers.length > 0) {
      log('Syncing', answers);
      log('Category', category.id);
      await startSync(category.id, answers);
    }
  }
}

try {
  if (args.c) {
    await sync(await getCategory(args.c));
  } else {
    const set = await findSet({ allowParent: true });

    if (await ask('Update Defaults?', false)) {
      await updateCategory(set.category.id, await updateSetDefaults(set.category.metadata || undefined));
    }

    if (args.d) {
      await deleteCardsFromSet(set.category);
    } else {
      if (await ask(`Build Products for ${set.category.name}?`, !(args.d || args.s || args.only))) {
        await buildSet(set);
      }
      await sync(set.category);
    }
  }
} catch (e) {
  console.error(e);
} finally {
  await shutdown();
  process.exit();
}

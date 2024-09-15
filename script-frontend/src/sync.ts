import dotenv from 'dotenv';
import 'zx/globals';
import { shutdownSportLots } from './listing-sites/sportlots';
import { useSpinners } from './utils/spinners';
import { buildSet, findSet, updateSetDefaults } from './card-data/setData';
import initializeFirebase from './utils/firebase';
import { deleteCardsFromSet, startSync, updateCategory } from './utils/medusa';
import { ask } from './utils/ask';
import { checkbox } from '@inquirer/prompts';
import { parseArgs } from './utils/parseArgs';

const args = parseArgs(
  {
    boolean: ['d', 's'],
    string: ['o'],
    alias: {
      d: 'delete',
      o: 'only',
      s: 'select',
    },
  },
  {
    d: 'Delete records from Medusa',
    o: 'Only sync selected platforms. Platforms: sportlots(sl), bsc, ebay, mcp',
    s: 'Select platforms to sync',
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

try {
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

    if (!args.only && !args.s && (await ask(`Sync All listing from ${set.category.name}?`, true))) {
      await startSync(set.category.id, args.only?.split(','));
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
        ],
      });
      if (answers && answers.length > 0) {
        await startSync(set.category.id, answers);
      }
    }
  }
} finally {
  await shutdown();
  process.exit();
}

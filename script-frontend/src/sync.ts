import dotenv from 'dotenv';
import 'zx/globals';
import minimist from 'minimist';
import { shutdownSportLots } from './listing-sites/sportlots';
import { useSpinners } from './utils/spinners';
import { buildSet, findSet, updateSetDefaults } from './card-data/setData';
import initializeFirebase from './utils/firebase';
import { startSync, updateCategory } from './utils/medusa';
import { ask } from './utils/ask';

const args = minimist(process.argv.slice(2));

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
  const set = await findSet(true);

  if (await ask('Update Defaults?', false)) {
    await updateCategory(set.category.id, await updateSetDefaults());
  }

  if (await ask(`Build Products for ${set.category.name}?`, true)) {
    await buildSet(set);
  }

  if (await ask(`Sync All listing from ${set.category.name}?`, true)) {
    await startSync(set.category.id);
  }
} finally {
  await shutdown();
  process.exit();
}

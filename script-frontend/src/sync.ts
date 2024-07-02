import dotenv from 'dotenv';
import 'zx/globals';
import minimist from 'minimist';
import { shutdownSportLots } from './listing-sites/sportlots';
import { useSpinners } from './utils/spinners';
import { buildSet, findSet } from './card-data/setData';
import initializeFirebase from './utils/firebase';

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
  const set = await findSet();
  // const set = await getCategory('pcat_01HWQACW0A7Q9XBEN1W84TJX3H');
  log(set);
  const shouldBuildSet = true; //await ask('Continue?', false);
  if (shouldBuildSet) {
    await buildSet(set);
  }
} finally {
  await shutdown();
}

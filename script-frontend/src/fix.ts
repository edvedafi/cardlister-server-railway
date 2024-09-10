import dotenv from 'dotenv';
import 'zx/globals';
import minimist from 'minimist';
import { useSpinners } from './utils/spinners';
import { fixVariants } from './utils/medusa';
import { findSet } from './card-data/setData';

const args = minimist(process.argv.slice(2));

$.verbose = false;

dotenv.config();

const { showSpinner, log } = useSpinners('Sync', chalk.cyanBright);
//
// let isShuttingDown = false;
// const shutdown = async () => {
//   if (!isShuttingDown) {
//     isShuttingDown = true;
//     await Promise.all([shutdownSportLots()]);
//   }
// };
//
// ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
//   process.on(
//     signal,
//     async () =>
//       await shutdown().then(() => {
//         process.exit();
//       }),
//   ),
// );
//
// initializeFirebase();

const { update, finish, error } = showSpinner('top-level', 'Fixing product variants');
try {
  const set = await findSet({ allowParent: true });
  update(set.category.name);
  await fixVariants(set.category.id);
  finish();
} catch (e) {
  error(e);
} finally {
  // await shutdown();
  process.exit();
}

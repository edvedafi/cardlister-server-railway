import dotenv from 'dotenv';
import 'zx/globals';
import minimist from 'minimist';
import { shutdownSportLots } from './listing-sites/sportlots';
import { useSpinners } from './utils/spinners';
import { buildSet, findSet, updateSetDefaults } from './card-data/setData';
import initializeFirebase from './utils/firebase';
import {
  addOptions,
  getCategories,
  getCategory,
  getProducts,
  getRootCategory,
  startSync,
  updateCategory,
} from './utils/medusa';
import { ask } from './utils/ask';
import { checkbox } from '@inquirer/prompts';
import type { Product, ProductCategory } from '@medusajs/client-types';
import type { Category } from './models/setInfo';

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
  const processCateogry = async (categoryId: string) => {
    const { finish, error } = showSpinner(categoryId, categoryId);
    try {
      const children = await getCategories(categoryId);
      if (children && children.length > 0) {
        for (const child of children) {
          await processCateogry(child.id);
        }
      } else {
        const products = await getProducts(categoryId);
        if (products) {
          for (const product of products) {
            if (product.options && product.options.length > 0) {
              log(`Product ${product.id} has options`);
            } else {
              await addOptions(product);
            }
          }
        }
      }
    } catch (e) {
      error(e);
    }
    finish(categoryId);
  };
  update('Fetch Root');
  const rootId = await getRootCategory();
  await processCateogry(rootId);
  finish();
} catch (e) {
  error(e);
} finally {
  // await shutdown();
  process.exit();
}

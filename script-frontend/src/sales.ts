import dotenv from 'dotenv';
import 'zx/globals';
import { shutdownSportLots } from './listing-sites/sportlots';
import { shutdownSportLots as oldShutdownSportLots } from './old-scripts/sportlots';
import { useSpinners } from './utils/spinners';
import initializeFirebase from './utils/firebase';
import {
  completeOrder,
  getOrders,
  getProduct,
  getProductVariant,
  getProductVariantBySKU,
  getSales,
} from './utils/medusa';
import type { Order } from '@medusajs/client-types';
// @ts-expect-error - no types
import chalkTable from 'chalk-table';
import { buildTableData, type OldSale } from './utils/data';
import { getSingleListingInfo } from './old-scripts/firebase';
import { removeFromSportLots } from './old-scripts/sportlots';
import { removeFromBuySportsCards, shutdownBuySportsCards } from './old-scripts/bsc';
import { removeFromEbay } from './old-scripts/ebay';
import { removeFromMyCardPost, shutdownMyCardPost } from './old-scripts/mycardpost';
import { convertTitleToCard, createGroups } from './old-scripts/uploads';

$.verbose = false;

dotenv.config();

const { log, showSpinner } = useSpinners('Sync', chalk.cyanBright);

let isShuttingDown = false;
const shutdown = async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    await Promise.all([shutdownSportLots(), oldShutdownSportLots(), shutdownBuySportsCards(), shutdownMyCardPost()]);
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
const { update, error, finish } = showSpinner('top-level', 'Running sales processing');

try {
  update('Get Orders from Platforms');
  // await getSales();

  update('Gather Orders');
  const orders: Order[] = await getOrders();
  if (orders.length > 0) {
    update('Process old orders');

    //first find old style cards
    const oldSales: OldSale[] = [];
    for (const order of orders) {
      if (!order.items) throw new Error('Order has no items');
      log('Items', order);
      for (const item of order.items) {
        let variant = item.variant;
        if (item.variant_id && !variant) {
          variant = await getProductVariant(item.variant_id);
        }
        // if (!variant && item.metadata?.sku) {
        //   variant = await getProductVariantBySKU(item.metadata?.sku);
        // }
        if (variant) {
          log(`Found variant for ${item.title}`);
          item.variant = variant;
        } else {
          log(`Could not find variant for ${JSON.stringify(item)}`);
          const cardFromTitle = convertTitleToCard(item.title);
          const fuzzy = await getSingleListingInfo(cardFromTitle);
          if (fuzzy) {
            fuzzy.quantity = item.quantity;
            fuzzy.sku = item.metadata?.sku;
            fuzzy.platform = order.metadata?.platform;
            oldSales.push(fuzzy);
          } else {
            throw new Error(`Could not find old style match for ${item.title}`);
          }
        }
      }
    }

    // const oldSales = fs.readJSONSync('oldSales.json');
    const groupedCards = await createGroups({}, oldSales);
    fs.writeJSONSync('oldSales.json', oldSales);

    update('Remove listings from sites');
    await removeFromEbay(oldSales);
    await removeFromSportLots(groupedCards);
    await removeFromBuySportsCards(groupedCards);
    await removeFromMyCardPost(oldSales);

    update('Fulfill orders');
    for (const order of orders) {
      await completeOrder(order);
    }

    update('Display Pull Table');
    console.log(
      chalkTable(
        {
          leftPad: 2,
          columns: [
            { field: 'sport', name: 'Sport' },
            { field: 'year', name: 'Year' },
            { field: 'quantity', name: 'Count' },
            { field: 'title', name: 'Title' },
            { field: 'platform', name: 'Sold On' },
          ],
        },
        await buildTableData(orders, oldSales),
      ),
    );
    update('Open external sites');
    finish(`Processed ${orders.length} orders`);
  } else {
    finish('No orders to process');
  }
} catch (e) {
  error(e);
} finally {
  await shutdown();
  process.exit();
}

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
import open from 'open';

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
  await getSales();

  update('Gather Orders');
  const orders: Order[] = await getOrders();
  if (orders.length > 0) {
    update('Process old orders');

    //first find old style cards
    const oldSales: OldSale[] = [];
    for (const order of orders) {
      if (!order.items) throw new Error('Order has no items');
      for (const item of order.items) {
        let variant = item.variant;
        if (item.variant_id && !variant) {
          variant = await getProductVariant(item.variant_id);
        }
        if (variant) {
          item.variant = variant;
        } else {
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
    if (oldSales && oldSales.length > 0) {
      await removeFromEbay(oldSales);
      await removeFromMyCardPost(oldSales);
      if (groupedCards && Object.keys(groupedCards).length > 0) {
        await removeFromSportLots(groupedCards);
        await removeFromBuySportsCards(groupedCards);
      }
    }

    update('Fulfill orders');
    for (const order of orders) {
      await completeOrder(order);
    }

    update('Build display pull table');
    const output = await buildTableData(orders, oldSales);

    update('Open external sites');
    if (orders.find((sale) => sale.metadata?.platform.indexOf('SportLots: ') > -1)) {
      await open('https://sportlots.com/inven/dealbin/dealacct.tpl?ordertype=1a');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('BSC: ') > -1)) {
      await open('https://www.buysportscards.com/sellers/orders');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('MCP: ') > -1)) {
      await open('https://www.mycardpost.com/edvedafi/orders');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('ebay: ') > -1)) {
      await open('https://www.ebay.com/sh/ord?filter=status:AWAITING_SHIPMENT');
    }

    finish(`Processed ${orders.length} orders`);
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
        output,
      ),
    );
  } else {
    finish('No orders to process');
  }
} catch (e) {
  error(e);
} finally {
  if (fs.existsSync('oldSales.json')) {
    fs.removeSync('oldSales.json');
  }
  await shutdown();
  process.exit();
}

import dotenv from 'dotenv';
import 'zx/globals';
import { shutdownSportLots } from './listing-sites/sportlots';
import { removeFromSportLots, shutdownSportLots as oldShutdownSportLots } from './old-scripts/sportlots';
import { useSpinners } from './utils/spinners';
import initializeFirebase from './utils/firebase';
import { completeOrder, getOrders, getProductVariant, getSales } from './utils/medusa';
import type { Order } from '@medusajs/client-types';
import { parseArgs } from './utils/parseArgs';
// @ts-expect-error - no types
import chalkTable from 'chalk-table';
import { buildTableData, type OldSale } from './utils/data';
import { getSingleListingInfo } from './old-scripts/firebase';
import { removeFromBuySportsCards, shutdownBuySportsCards } from './old-scripts/bsc';
import { shutdownMyCardPost } from './old-scripts/mycardpost';
import { convertTitleToCard, createGroups } from './old-scripts/uploads';
import open from 'open';
import { removeFromEbay } from './old-scripts/ebay';

$.verbose = false;

dotenv.config();

const args = parseArgs(
  {
    string: ['d'],
    boolean: ['o', 'n', 'r'],
    alias: {
      o: 'skip-old',
      r: 'skip-old-remove',
      n: 'skip-new',
      d: 'days',
    },
  },
  {
    o: 'Skip all Old Sales',
    r: 'Skip the Remove step for Old Sales',
    n: 'No new sales batch processing',
    d: 'Get all of the orders from the last n days',
  },
);

const { showSpinner } = useSpinners('Sync', chalk.cyanBright);

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
  if (!args['skip-new'] && !args['days']) {
    update('Get Orders from Platforms');
    await getSales();
  }

  update('Gather Orders');
  const orders: Order[] = await getOrders();
  if (orders.length > 0) {
    update('Process old orders');

    let oldSales: OldSale[] = [];
    if (args['skip-old']) {
      if (fs.existsSync('oldSales.json')) {
        oldSales = fs.readJSONSync('oldSales.json');
      }
    } else {
      //first find old style cards
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
      fs.writeJSONSync('oldSales.json', oldSales);

      if (!args['skip-old-remove']) {
        const groupedCards = await createGroups({}, oldSales);
        update('Remove listings from sites');
        if (oldSales && oldSales.length > 0) {
          await removeFromEbay(oldSales);
          // await removeFromMyCardPost(oldSales);
          if (groupedCards && Object.keys(groupedCards).length > 0) {
            await removeFromSportLots(groupedCards);
            await removeFromBuySportsCards(groupedCards);
          }
        }
      }
    }

    update('Fulfill orders');
    for (const order of orders) {
      await completeOrder(order);
    }

    update('Build display pull table');
    const output = await buildTableData(orders, oldSales);

    update('Open external sites');
    if (orders.find((sale) => sale.metadata?.platform.indexOf('SportLots - ') > -1)) {
      await open('https://sportlots.com/inven/dealbin/dealacct.tpl?ordertype=1a');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('BSC - ') > -1)) {
      await open('https://www.buysportscards.com/sellers/orders');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('MCP - ') > -1)) {
      await open('https://www.mycardpost.com/edvedafi/orders');
    }
    if (orders.find((sale) => sale.metadata?.platform.indexOf('ebay - ') > -1)) {
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

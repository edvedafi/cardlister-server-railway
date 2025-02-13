import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import initializeFirebase from './utils/firebase';
import { completeOrder, getOrders, getProductVariant, getSales } from './utils/medusa';
import type { Order } from '@medusajs/client-types';
import { parseArgs } from './utils/parseArgs';
// @ts-expect-error - no types
import chalkTable from 'chalk-table';
import { buildTableData, type OldSale } from './utils/data';
import open from 'open';

$.verbose = false;

dotenv.config();

const args = parseArgs(
  {
    string: ['d', 's'],
    boolean: ['o', 'n', 'r'],
    alias: {
      n: 'new-sales',
      d: 'days',
      s: 'sku',
    },
  },
  {
    o: 'Skip all Old Sales',
    r: 'Remove cards for Old School style Sales',
    n: 'Gather all new sales from platforms before processing',
    d: 'Get all of the orders from the last n days',
    s: 'Display all sales of a SKU',
  },
);

const { showSpinner } = useSpinners('Sync', chalk.cyanBright);

initializeFirebase();
const { update, error, finish } = showSpinner('top-level', 'Running sales processing');

try {
  if (args['new-sales']) {
    update('Get Orders from Platforms');
    await getSales();
  }

  update('Gather Orders');
  const orders: Order[] = await getOrders({ lastNdays: args['days'], sku: args['sku'] });
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
            console.error(`Could not find variant for ${item.title}`);
            // const cardFromTitle = convertTitleToCard(item.title);
            // const fuzzy = await getSingleListingInfo(cardFromTitle);
            // if (fuzzy) {
            //   fuzzy.quantity = item.quantity;
            //   fuzzy.sku = item.metadata?.sku;
            //   fuzzy.platform = order.metadata?.platform;
            //   oldSales.push(fuzzy);
            // } else {
            //   throw new Error(`Could not find old style match for ${item.title}`);
            // }
          }
        }
      }
    }

    update('Fulfill orders');
    for (const order of orders) {
      await completeOrder(order);
    }

    update('Build display pull table');
    const output = await buildTableData(orders, oldSales, args['sku']);

    if (!args['sku']) {
      update('Open external sites');
      if (orders.find((sale) => sale.metadata?.platform.indexOf('SportLots - ') > -1)) {
        await open('https://sportlots.com/inven/dealbin/dealacct.tpl?ordertype=1a', { app: { name: 'firefox' } });
      }
      if (orders.find((sale) => sale.metadata?.platform.indexOf('BSC - ') > -1)) {
        await open('https://www.buysportscards.com/sellers/orders', { app: { name: 'firefox' } });
      }
      if (orders.find((sale) => sale.metadata?.platform.indexOf('MCP - ') > -1)) {
        await open('https://www.mycardpost.com/edvedafi/orders', { app: { name: 'firefox' } });
      }
      if (orders.find((sale) => sale.metadata?.platform.indexOf('ebay - ') > -1)) {
        await open('https://www.ebay.com/sh/ord?filter=status:AWAITING_SHIPMENT', { app: { name: 'firefox' } });
      }
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
}

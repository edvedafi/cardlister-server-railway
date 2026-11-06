import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import initializeFirebase from './utils/firebase';
import {
  cancelSportlotsImport,
  completeOrder,
  confirmSportlotsImport,
  getOrders,
  getProduct,
  getProductVariant,
  getSales,
  previewSportlotsImport,
  startSync,
} from './utils/medusa';
import { ask } from './utils/ask';
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
    string: ['d', 's', 'i'],
    boolean: ['o', 'n', 'r', 'y'],
    alias: {
      n: 'new-sales',
      d: 'days',
      s: 'sku',
      y: 'sync',
      i: 'sl-import',
    },
  },
  {
    o: 'Skip all Old Sales',
    r: 'Remove cards for Old School style Sales',
    n: 'Gather all new sales from platforms before processing',
    d: 'Get all of the orders from the last n days',
    s: 'Display all sales of a SKU',
    y: 'Print pending orders and sync their categories to listing platforms',
    i: 'Create SportLots orders from saved pull report HTML files first: -i shipped.html boxed.html',
  },
);

const { showSpinner } = useSpinners('Sync', chalk.cyanBright);

initializeFirebase();

async function importSportlotsReports(files: string[]): Promise<void> {
  if (files.length === 0) throw new Error('--sl-import needs at least one pull report file');
  const reports = files.map((file) => fs.readFileSync(file, 'utf8'));

  console.log('Reading the pull reports...');
  const { jobId, orders: preview } = await previewSportlotsImport(reports);

  const rows = preview.flatMap((order) =>
    order.items.map((item) => ({
      order: order.username,
      quantity: item.quantity,
      sku: item.sku,
      title: item.title,
      price: `$${(item.unit_price / 100).toFixed(2)}`,
      status: order.alreadyImported ? 'already imported' : item.matched ? 'ok' : chalk.red('NO MATCH'),
    })),
  );
  console.log(
    chalkTable(
      {
        leftPad: 2,
        columns: [
          { field: 'order', name: 'Buyer' },
          { field: 'quantity', name: 'Qty' },
          { field: 'sku', name: 'SKU' },
          { field: 'title', name: 'Title' },
          { field: 'price', name: 'Each' },
          { field: 'status', name: 'Status' },
        ],
      },
      rows,
    ),
  );

  const unmatched = preview.filter((o) => !o.alreadyImported).flatMap((o) => o.items.filter((i) => !i.matched));
  if (unmatched.length > 0) {
    console.log(chalk.red(`${unmatched.length} line(s) match no card: they'll be recorded, but nothing gets taken down.`));
  }

  const newOrders = preview.filter((order) => !order.alreadyImported);
  if (newOrders.length === 0) {
    console.log('Every order was already imported.');
    await cancelSportlotsImport(jobId);
    return;
  }

  if (!(await ask(`Create ${newOrders.length} SportLots order(s) and take these cards down?`, false))) {
    await cancelSportlotsImport(jobId);
    console.log('Import cancelled; nothing was created.');
    process.exit(0);
  }

  console.log('Creating the orders...');
  await confirmSportlotsImport(jobId);

  // The sales job logs a per-order failure and still completes, so check the orders really exist.
  const pending = await getOrders({});
  const missing = newOrders.filter(
    (order) => !pending.some((o) => o.metadata?.platform === `SportLots - ${order.username}`),
  );
  if (missing.length > 0) {
    throw new Error(`No pending order found for ${missing.map((o) => o.id).join(', ')}; check the backend logs`);
  }
}

if (args['sl-import'] !== undefined) {
  try {
    await importSportlotsReports([args['sl-import'], ...args._].flat().filter(Boolean));
  } catch (e) {
    console.error(chalk.red(`SportLots import failed: ${(e as Error).message}`));
    process.exit(1);
  }
}

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

    if (args['sync']) {
      const categoryIds = new Set<string>();
      for (const order of orders) {
        for (const item of order.items ?? []) {
          const variant = item.variant;
          if (variant?.product_id) {
            const product = await getProduct(variant.product_id);
            if (product.categories?.length) {
              categoryIds.add(product.categories[0].id);
            }
          }
        }
      }
      for (const categoryId of categoryIds) {
        await startSync(categoryId);
      }
    }
  } else {
    finish('No orders to process');
  }
} catch (e) {
  error(e);
}

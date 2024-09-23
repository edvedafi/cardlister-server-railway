import Medusa from '@medusajs/medusa-js';
import dotenv from 'dotenv';
import type { Metadata } from '../models/setInfo';
import type {
  BatchJob,
  DecoratedInventoryItemDTO,
  InventoryItemDTO,
  MoneyAmount,
  Order,
  PricedProduct,
  PricedVariant,
  Product,
  ProductCategory,
  ProductVariant,
} from '@medusajs/client-types';
import { useSpinners } from './spinners';
import chalk from 'chalk';
import axios, { type AxiosError } from 'axios';

const { showSpinner, log } = useSpinners('Medusa', chalk.greenBright);

dotenv.config();

const medusa = new Medusa({
  apiKey: process.env.MEDUSA_ADMIN_KEY,
  baseUrl: process.env.MEDUSA_BACKEND_URL as string,
  maxRetries: 3,
});

export async function generateKey(username: string, pass: string, key: string) {
  const temp = new Medusa({
    baseUrl: process.env.MEDUSA_BACKEND_URL as string,
    maxRetries: 3,
  });
  await temp.admin.auth.getToken({
    email: username,
    password: pass,
  });

  const { users } = await temp.admin.users.list({ email: username });
  if (users.length !== 1) throw `Found ${users.length} users with email ${username}!`;
  const { user } = await temp.admin.users.update(users[0].id, {
    api_token: key,
  });
  console.log(user.api_token);
}

export async function createCategory(
  name: string,
  parent_category_id: string,
  handle: string,
  metadata = {},
): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.create({
    name: name,
    handle: handle.toLowerCase().replace(/ /g, '-'),
    is_internal: true,
    is_active: false,
    parent_category_id: parent_category_id,
    metadata,
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_category;
}

export async function createCategoryActive(
  name: string,
  description: string,
  parent_category_id: string,
  handle: string,
  metadata = {},
): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.create({
    name: name,
    description: description,
    handle: handle.toLowerCase().replace(/ /g, '-'),
    is_active: true,
    is_internal: false,
    parent_category_id: parent_category_id,
    metadata,
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_category;
}

export async function setCategoryActive(
  id: string,
  description: string,
  metadataUpdates: Metadata,
): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.update(id, {
    description: description,
    is_active: true,
    is_internal: false,
    metadata: metadataUpdates,
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_category;
}

export async function updateCategory(id: string, metadataUpdates: Metadata): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.update(id, { metadata: metadataUpdates });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_category || {};
}

export async function getRootCategory(): Promise<string> {
  const { product_categories } = await medusa.admin.productCategories.list({ handle: 'root' });
  return product_categories[0].id;
}

export async function getCategories(parent_category_id: string): Promise<ProductCategory[]> {
  const response = await medusa.admin.productCategories.list({
    parent_category_id: parent_category_id,
    include_descendants_tree: false,
    // fields: 'name',
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_categories;
}

export async function getCategory(id: string): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.retrieve(id);
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product_category;
}

export type Variation = {
  title: string;
  sku: string;
  metadata?: Metadata;
};

export async function createProduct(product: Product, variations: Variation[] = []): Promise<Product> {
  log('Creating SKUs: ', variations.map((v) => v.sku).join(', '));
  const payload = {
    title: product.title,
    description: product.description as string,
    weight: product.weight as number,
    length: product.length as number,
    width: product.width as number,
    height: product.height as number,
    origin_country: product.origin_country as string,
    material: product.material as string,
    metadata: product.metadata || {},
    categories: [{ id: product.categories?.[0].id || '' }],
    is_giftcard: false,
    discountable: true,
    variants: variations.map((variation) => ({
      title: variation.title,
      manage_inventory: true,
      prices: [{ currency_code: 'usd', amount: 99 }],
      sku: variation.sku,
    })),
  };
  if (product.metadata?.features) {
    payload.metadata.features = Array.isArray(product.metadata.features)
      ? product.metadata.features
      : [product.metadata.features];
  }
  const response = await medusa.admin.products.create(payload);
  for (const variant of response.product.variants) {
    await medusa.admin.products.updateVariant(response.product.id, variant.id, {
      metadata: variations.find((v) => v.sku === variant.sku)?.metadata,
    });
  }
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function updateProductImages(product: { id: string; images: string[] }): Promise<Product> {
  const response = await medusa.admin.products.update(product.id, {
    images: product.images.map(
      (image) => `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${image}?alt=media`,
    ),
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function addOptions(product: Product): Promise<Product> {
  const { finish } = showSpinner(product.id, 'Adding options to ' + product.title);
  const response = await medusa.admin.products.addOption(product.id, {
    title: 'Type',
  });
  finish();
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function updateProductVariant(productVariant: ProductVariant): Promise<Product> {
  if (!productVariant.prices) throw 'No prices to update';
  if (!productVariant.product) throw 'No product to update';

  let response;
  if (productVariant.prices.length > 0) {
    try {
      response = await medusa.admin.products.updateVariant(productVariant.product.id, productVariant.id, {
        // @ts-expect-error fighting the medusa-js types
        // prices: productVariant.prices.map((price: MoneyAmount) =>
        //   typeof price.amount === 'string' ? { ...price, amount: parseInt(price.amount) } : price,
        // ),
        prices: productVariant.prices,
        // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
        metadata: productVariant.metadata,
      });
    } catch (e) {
      // @ts-expect-error cannot figure out how to type case this correctly
      const message = e.response?.data?.message || e.message;
      throw `Failed to save variant ${productVariant.id} for product ${productVariant.product.id} with prices: 
      ${JSON.stringify(productVariant.prices, null, 2)}
      Error: ${message}`;
    }
  } else if (productVariant.metadata) {
    response = await medusa.admin.products.updateVariant(productVariant.product.id, productVariant.id, {
      metadata: productVariant.metadata,
    });
  } else {
    response = productVariant;
  }

  if (!response.product)
    throw new Error(`Failed to update product variant ${productVariant.id} for product ${productVariant.product.id}`);

  // @ts-expect-error cannot figure out how to type case this correctly
  return response.product;
}

export async function getProductCardNumbers(category: string): Promise<string[]> {
  const response = await medusa.admin.products.list({
    category_id: [category],
    fields: 'metadata,variants.metadata',
    expand: 'variants',
    limit: 1000,
  });
  return response.products
    ? // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
      response.products.flatMap((product: Product | PricedProduct) =>
        product.variants?.map((v: ProductVariant) => v.metadata?.cardNumber),
      )
    : [];
}

type RegionCache = { [key: string]: string };
let regionCache: RegionCache;

export async function getRegion(regionName: string): Promise<string> {
  if (!regionCache) {
    const response = await medusa.admin.regions.list();
    regionCache = response.regions.reduce((acc: RegionCache, region: { id: string; name: string }) => {
      acc[region.name] = region.id;
      return acc;
    }, {});
  }
  return regionCache[regionName];
}

export async function startSync(categoryId: string, only: string[] = []) {
  console.log(`Starting sync for ${categoryId} ${only}`);
  return await runBatches('sync', only, { category: categoryId });
}

export async function getSales(only: string[] = []) {
  return runBatches('sales', only);
}

export async function fixVariants(categoryId: string) {
  return runBatches('fix', [], { category: categoryId });
}

async function runBatches(type: string, only: string[] = [], context: { [key: string]: unknown } = {}): Promise<void> {
  if (only.length > 0) {
    context.only = only;
  }
  console.log(`Running ${type} batches with context: ${JSON.stringify(context)}`);
  const response = await medusa.admin.custom.post(type, context);
  await Promise.all(
    response.result.map(async (batch: BatchJob) => {
      let job = batch;
      const { product_category } = job.context?.category_id
        ? await medusa.admin.productCategories.retrieve(job.context?.category_id)
        : { product_category: undefined };
      const { update, error, finish } = showSpinner(
        `batch-${job.id}`,
        `${job.type}::${job.id}::${product_category ? product_category.description : JSON.stringify(job.context)}`,
      );
      while (!['completed', 'failed'].includes(job.status)) {
        update(job.status);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const res = await medusa.admin.batchJobs.retrieve(job.id);
        // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
        job = res.batch_job;
        if (job.status === 'processing') {
          update(`${job.status} ${job.result?.advancement_count}/${job.result?.count}`);
        } else {
          update(job.status);
        }
      }
      if (job.status === 'completed' && !job.result?.errors) {
        finish(`${job.result?.count} Complete`);
      } else {
        // log(job.result);
        // if (job.result?.errors) {
        //   // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
        //   job.result?.errors?.forEach((e: string) => console.error(e.err || e));
        // }
        // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
        const errors = job.result?.errors?.map((e) => e.err).join('\n');
        error((job.result?.errors?.message || 'Failed  ') + '\n  ' + errors + '\n ');
      }
    }),
  );
}

export async function getAllBatchJobs(): Promise<BatchJob[]> {
  const response = await medusa.admin.batchJobs.list({ limit: 1000, offset: 0 });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.batch_jobs.filter((job) => !['canceled', 'completed', 'failed'].includes(job.status));
}

export async function cancelSync(batchId: string) {
  log(`Cancelling ${batchId}`);
  const response = await medusa.admin.batchJobs.cancel(batchId);
  console.log(response.batch_job);
}

export async function getProduct(id: string): Promise<Product> {
  const response = await medusa.admin.products.retrieve(id);
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function getProductVariant(variantId: string): Promise<PricedVariant> {
  const response = await medusa.admin.variants.retrieve(variantId);
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.variant;
}

const variantCache: { [key: string]: PricedVariant } = {};

export async function getProductVariantBySKU(sku: string): Promise<PricedVariant> {
  if (Object.keys(variantCache).length === 0) {
    let offset = 0;
    const limit = 10000;
    let response;

    while (!response || response.variants.length === limit) {
      response = await medusa.admin.variants.list({ offset, limit });
      // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
      response.variants.forEach((variant: PricedVariant) => {
        if (variant.sku) {
          variantCache[variant.sku] = variant;
        }
      });
      offset += limit;
    }
  }
  return variantCache[sku];
}

//TODO This does not support multiple users
let _stockLocationId: string;

export async function getStockLocationId(): Promise<string> {
  if (!_stockLocationId) {
    const response = await medusa.admin.stockLocations.list();
    _stockLocationId = response.stock_locations[0].id;
  }
  return _stockLocationId;
}

export async function getInventory(productVariant: ProductVariant): Promise<DecoratedInventoryItemDTO> {
  if (!productVariant.sku) throw new Error('Product variant does not have a SKU');
  const response = await medusa.admin.inventoryItems.list({ sku: productVariant.sku });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  let inventoryItem: DecoratedInventoryItemDTO = response.inventory_items?.[0];

  if (!inventoryItem) {
    const createResponse = await medusa.admin.inventoryItems.create({
      variant_id: productVariant.id,
      sku: productVariant.sku,
    });
    // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
    inventoryItem = createResponse.inventory_item;
  }

  const stockLocationId = await getStockLocationId();
  if (!inventoryItem.location_levels?.find((level: { location_id: string }) => level.location_id === stockLocationId)) {
    await medusa.admin.inventoryItems.createLocationLevel(inventoryItem.id as string, {
      location_id: stockLocationId,
      stocked_quantity: 0,
    });
  }

  return inventoryItem;
}

export async function getInventoryQuantity(productVariant: ProductVariant): Promise<number> {
  const inventoryItem = await getInventory(productVariant);
  const stockLocationId = await getStockLocationId();
  const locationLevel = inventoryItem.location_levels?.find(
    (level: { location_id: string }) => level.location_id === stockLocationId,
  );
  return locationLevel?.stocked_quantity || 0;
}

export async function updateInventory(
  inventoryItem: InventoryItemDTO,
  quantity: string | number,
): Promise<InventoryItemDTO | undefined> {
  if (inventoryItem && inventoryItem.id) {
    const response = await medusa.admin.inventoryItems.updateLocationLevel(
      inventoryItem.id,
      await getStockLocationId(),
      {
        stocked_quantity: typeof quantity === 'number' ? quantity : parseInt(quantity),
      },
    );
    // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
    return response.inventory_item;
  }
}

export async function updatePrices(productId: string, variantId: string, prices: MoneyAmount[]): Promise<Product> {
  const response = await medusa.admin.products.updateVariant(productId, variantId, {
    // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
    prices: prices,
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function getProducts(category: string): Promise<Product[]> {
  const response = await medusa.admin.products.list({
    category_id: [category],
    limit: 1000,
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.products;
}

export async function getOrders(lastNdays?: string): Promise<Order[]> {
  let response;
  if (lastNdays && parseInt(lastNdays) > 0) {
    const today = new Date();
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - parseInt(lastNdays));
    response = await medusa.admin.orders.list({
      created_at: { gt: pastDate },
      limit: 100,
      offset: 0,
      expand: 'items,items.variant',
    });
  } else {
    response = await medusa.admin.orders.list({
      status: ['pending'],
      limit: 100,
      offset: 0,
      expand: 'items,items.variant',
    });
  }
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.orders;
}

export async function completeOrder(order: Order): Promise<void> {
  if (order.status === 'pending') {
    if (order.items && order.items?.length > 0) {
      try {
        const fulfillmentResponse = await medusa.admin.orders.createFulfillment(order.id, {
          location_id: await getStockLocationId(),
          items: order.items.map((li) => ({ item_id: li.id, quantity: li.quantity })),
        });
        await medusa.admin.orders.createShipment(order.id, {
          fulfillment_id: fulfillmentResponse.order.fulfillments[0].id,
        });
      } catch (e: AxiosError | unknown) {
        if (axios.isAxiosError(e)) {
          if (e.response?.data?.message?.indexOf('Insufficient stock') !== -1) {
            log(e.response?.data?.message);
          } else if (e.response?.data?.message?.indexOf('lacks shipping methods') !== -1) {
            log(e.response?.data?.message);
          } else if (e.response?.data?.message?.indexOf('annot fulfill more items than have been purchased') !== -1) {
            log(e.response?.data?.message);
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }
    await medusa.admin.orders.complete(order.id);
  }
}

export async function deleteCardsFromSet(category: ProductCategory) {
  const { update, finish } = showSpinner('delete', 'Deleting Cards');
  const cards = await getProducts(category.id);
  let offset = 0;
  let inventoryResponse;
  while (!inventoryResponse || inventoryResponse.count > offset) {
    inventoryResponse = await medusa.admin.inventoryItems.list({ limit: 1000, offset: offset });
    const inventoryItems = inventoryResponse.inventory_items;
    update('Inventory Items');
    for (const inventoryItem of inventoryItems) {
      // log(`Checking ${inventoryItem.sku} for BIN ${category.metadata?.bin}`);
      if (inventoryItem.sku?.startsWith(`${category.metadata?.bin}|`)) {
        // log(`Deleting ${inventoryItem.sku} from inventory`);
        const { inventory_item } = await medusa.admin.inventoryItems.listLocationLevels(inventoryItem.id);
        for (const level of inventory_item.location_levels) {
          await medusa.admin.inventoryItems.deleteLocationLevel(level.inventory_item_id, level.location_id);
        }
        await medusa.admin.inventoryItems.delete(inventoryItem.id);
      }
    }
    offset += 1000;
  }
  const i = 0;
  await Promise.all(
    cards.map((card) => {
      update(`${i}/${cards.length}`);
      return medusa.admin.products.delete(card.id);
    }),
  );
  finish(`Deleted ${cards.length} cards`);
}

export async function getNextBin() {
  const bins: number[] = [];
  const checkCategory = async (parent: string) => {
    const children = await getCategories(parent);
    for (const category of children) {
      if (category.metadata && category.metadata.bin) {
        const newBin = parseInt(category.metadata?.bin);
        bins.push(newBin);
      }
      await checkCategory(category.id);
    }
  };
  await checkCategory(await getRootCategory());
  let bin = 1;
  while (bins.includes(bin)) {
    bin++;
  }
}

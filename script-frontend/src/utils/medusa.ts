import Medusa from '@medusajs/medusa-js';
import dotenv from 'dotenv';
import type { Metadata } from '../models/setInfo';
import type {
  AdminProductsListRes,
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
import _ from 'lodash';

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
  return response.product_category;
}

export async function updateCategory(id: string, metadataUpdates: Metadata): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.update(id, { metadata: metadataUpdates });
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
  return response.product_categories;
}

export async function getCategory(id: string): Promise<ProductCategory> {
  const response = await medusa.admin.productCategories.retrieve(id);
  return response.product_category;
}

export type Variation = {
  title: string;
  sku: string;
  metadata?: Metadata;
};

async function getProductByHandle(handle: string): Promise<Product | null> {
  // Search for product by handle by listing products
  let offset = 0;
  const limit = 100;
  let hasMore = true;
  
  while (hasMore) {
    const response: AdminProductsListRes = await medusa.admin.products.list({
      limit,
      offset,
      expand: 'variants',
    });
    
    const foundProduct = response.products.find((p: Product) => p.handle === handle);
    if (foundProduct) {
      return foundProduct;
    }
    
    hasMore = response.products.length === limit;
    offset += limit;
    
    // Prevent infinite loop - if we've searched more than 10,000 products, give up
    if (offset > 10000) {
      break;
    }
  }
  
  return null;
}

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
    variants: variations
      // .filter((v) => v.metadata?.isBase)
      .map((variation) => ({
        title: variation.title,
        manage_inventory: true,
        prices: [{ currency_code: 'usd', amount: 99 }],
        sku: variation.sku,
      })),
  };
  if (product.metadata?.features) {
    payload.metadata.features = _.uniq(product.metadata.features).filter((f) => f);
  }

  let response;
  try {
    response = await medusa.admin.products.create(payload);
  } catch (error) {
    // Check if this is a duplicate handle error (422)
    if (axios.isAxiosError(error) && error.response?.status === 422) {
      const errorData = error.response?.data;
      const errorMessage = errorData?.message || '';
      
      // Check if it's a duplicate handle error
      if (errorMessage.includes('already exists') && errorMessage.includes('handle')) {
        // Extract handle from error message: "Product with handle结束后 X already exists."
        const handleMatch = errorMessage.match(/handle\s+([a-z0-9-]+)/i);
        if (handleMatch && handleMatch[1]) {
          const handle = handleMatch[1];
          log(`Product with handle "${handle}" already exists. Updating existing product...`);
          
          // Find the existing product
          const existingProduct = await getProductByHandle(handle);
          if (!existingProduct) {
            log(`Could not find existing product with handle "${handle}", rethrowing original error`);
            throw error;
          }
          
          log(`Found existing product: ${existingProduct.id} - ${existingProduct.title}`);
          
          // Update the existing product with new data
          try {
            const updatePayload: any = {
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
            };
            
            if (product.metadata?.features) {
              updatePayload.metadata = {
                ...updatePayload.metadata,
                features: _.uniq(product.metadata.features).filter((f) => f),
              };
            }
            
            response = await medusa.admin.products.update(existingProduct.id, updatePayload);
            log(`Updated product ${existingProduct.id}`);
            
            // Get updated product with variants
            const updatedProduct = await medusa.admin.products.retrieve(existingProduct.id, { expand: 'variants' });
            response = { product: updatedProduct.product };
            
            // Update or create variants
            for (const variation of variations) {
              const existingVariant = updatedProduct.product.variants?.find((v: ProductVariant) => v.sku === variation.sku);
              
              if (existingVariant) {
                // Update existing variant
                await medusa.admin.products.updateVariant(existingProduct.id, existingVariant.id, {
                  title: variation.title,
                  prices: [{ currency_code: 'usd', amount: 99 }],
                  metadata: variation.metadata,
                });
                log(`Updated variant ${existingVariant.sku}`);
              } else {
                // Create new variant
                try {
                  const variantResponse = await medusa.admin.products.addVariant(existingProduct.id, {
                    title: variation.title,
                    sku: variation.sku,
                    prices: [{ currency_code: 'usd', amount: 99 }],
                    manage_inventory: true,
                  });
                  
                  // Update variant metadata after creation
                  if (variation.metadata) {
                    await medusa.admin.products.updateVariant(
                      existingProduct.id,
                      variantResponse.product.variants?.find((v: ProductVariant) => v.sku === variation.sku)?.id || '',
                      { metadata: variation.metadata },
                    );
                  }
                  log(`Created new variant ${variation.sku}`);
                } catch (variantError) {
                  log(`Error creating variant ${variation.sku}: ${variantError}`);
                  // Continue with other variants
                }
              }
            }
            
            // Get final product state
            const finalProduct = await medusa.admin.products.retrieve(existingProduct.id, { expand: 'variants' });
            return finalProduct.product;
          } catch (updateError) {
            log(`Error updating existing product: ${updateError}`);
            throw updateError;
          }
        }
      }
    }
    
    // If not a duplicate handle error, log and throw as before
    console.log('Error creating product', error);
    const r: AdminProductsListRes = await medusa.admin.products.list({
      limit: 10000,
      fields: 'metadata,variants.metadata',
      expand: 'variants',
    });
    const skus = r.products.flatMap((p: Product) => p.variants?.map((v: ProductVariant) => v.sku));
    variations.forEach((v) => {
      if (!skus.includes(v.sku)) {
        console.log('Missing SKU', v.sku);
      } else {
        console.log('Found SKU', JSON.stringify(v, null, 2));
      }
    });
    throw new Error('Failed to create product');
  }
  // await ask('Product Created: Press Enter to Continue');
  for (const variant of response.product.variants) {
    await medusa.admin.products.updateVariant(response.product.id, variant.id, {
      metadata: variations.find((v) => v.sku === variant.sku)?.metadata,
    });
    // await ask(`Variant ${variant.sku} Created: Press Enter to Continue`);
  }
  return response.product;
}

export async function updateProductImages(product: { id: string; images: string[] }): Promise<Product> {
  const response = await medusa.admin.products.update(product.id, {
    images: product.images.map(
      (image) => `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${image}?alt=media`,
    ),
  });
  return response.product;
}

export async function addOptions(product: Product): Promise<Product> {
  const { finish } = showSpinner(product.id, 'Adding options to ' + product.title);
  const response = await medusa.admin.products.addOption(product.id, {
    title: 'Type',
  });
  finish();
  return response.product;
}

export async function updateProductVariant(productVariant: ProductVariant): Promise<Product> {
  if (!productVariant.prices) throw 'No prices to update';
  if (!productVariant.product) throw 'No product to update';

  let response;
  if (productVariant.prices.length > 0) {
    try {
      response = await medusa.admin.products.updateVariant(productVariant.product.id, productVariant.id, {
        prices: productVariant.prices,
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
    let cleanFeatures: string[] = _.uniq(productVariant.metadata.features).filter((feature) => feature) as string[];
    if (!cleanFeatures) {
      cleanFeatures = ['Base Set'];
    } else if (cleanFeatures.length === 0) {
      cleanFeatures.push('Base Set');
    }
    response = await medusa.admin.products.updateVariant(productVariant.product.id, productVariant.id, {
      metadata: cleanFeatures,
    });
  } else {
    response = productVariant;
  }

  if (!response.product) {
    throw new Error(`Failed to update product variant ${productVariant.id} for product ${productVariant.product.id}`);
  }

  return response.product;
}
export async function updateProductVariantMetadata(
  variant: string,
  product: string,
  metadata: Metadata,
): Promise<Product> {
  const response = await medusa.admin.products.updateVariant(product, variant, {
    metadata: metadata,
  });

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
    ? response.products.flatMap((product: Product | PricedProduct) =>
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

export async function getAllBatchJobs(logStatus = true, filter = true, onlySales = false): Promise<BatchJob[]> {
  let spinners;
  if (logStatus) {
    spinners = showSpinner('jobs', 'Getting Batch Jobs');
  }
  const jobs: BatchJob[] = [];
  const limit = 10000;
  let offset = 0;
  let count = 1;
  if (spinners) {
    spinners.update(`First ${limit}`);
  }
  while (count > offset) {
    const response = await medusa.admin.batchJobs.list({ limit, offset });
    if (filter) {
      jobs.push(
        ...response.batch_jobs.filter(
          (job: BatchJob) =>
            (!onlySales || job.type.indexOf('sale') > -1) && !['canceled', 'completed', 'failed'].includes(job.status),
        ),
      );
    } else {
      jobs.push(...response.batch_jobs);
    }
    count = response.count;
    offset += limit;
    if (spinners) {
      spinners.update(`${offset}/${count}`);
    }
  }
  if (spinners) {
    spinners.finish(`${offset}/${count}`);
  }
  return jobs;
}

export async function cancelSync(batchId: string) {
  log(`Cancelling ${batchId}`);
  const response = await medusa.admin.batchJobs.cancel(batchId);
  console.log(response.batch_job);
}

export async function getProduct(id: string): Promise<Product> {
  const response = await medusa.admin.products.retrieve(id);
  return response.product;
}

export async function getProductVariant(variantId: string): Promise<PricedVariant> {
  const response = await medusa.admin.variants.retrieve(variantId);
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
  let inventoryItem: DecoratedInventoryItemDTO = response.inventory_items?.[0];

  if (!inventoryItem) {
    const createResponse = await medusa.admin.inventoryItems.create({
      variant_id: productVariant.id,
      sku: productVariant.sku,
    });
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
    return response.inventory_item;
  }
}

export async function updatePrices(productId: string, variantId: string, prices: MoneyAmount[]): Promise<Product> {
  const response = await medusa.admin.products.updateVariant(productId, variantId, {
    prices: prices,
  });
  return response.product;
}

export async function getProducts(category: string): Promise<Product[]> {
  const response = await medusa.admin.products.list({
    category_id: [category],
    limit: 1000,
  });
  return response.products;
}

export interface OrderParams {
  lastNdays?: string;
  sku?: string;
}
export async function getOrders({ lastNdays, sku }: OrderParams): Promise<Order[]> {
  const { update, finish } = showSpinner('orders', 'Fetching Orders');
  let orders: Order[] = [];
  if (lastNdays && parseInt(lastNdays) > 0) {
    const today = new Date();
    const pastDate = new Date(today);
    pastDate.setDate(today.getDate() - parseInt(lastNdays));
    update(`Getting Orders for the last ${lastNdays} days`);
    const response = await medusa.admin.orders.list({
      created_at: { gt: pastDate },
      limit: 100,
      offset: 0,
      expand: 'items,items.variant',
    });
    orders = response.orders;
  } else if (sku) {
    update(`Getting Orders for SKU ${sku}`);
    const limit: number = 100;
    let offset: number = 0;
    let count: number = 1;
    while (count > offset) {
      update(`SKU: [${sku}]${offset > 0 ? ` ${offset}/${count}` : ''}`);
      const response = await medusa.admin.orders.list({
        limit,
        offset,
        expand: 'items,items.variant',
      });
      count = response.count;
      offset += limit;
      orders.push(...response.orders.filter((order: Order) => order.items?.some((item) => item.variant?.sku === sku)));
    }
  } else {
    update('Getting All pending Orders');
    const response = await medusa.admin.orders.list({
      status: ['pending'],
      limit: 100,
      offset: 0,
      expand: 'items,items.variant',
    });
    orders = response.orders;
  }
  finish();
  return orders;
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
  const response = await medusa.admin.custom.get('bin');
  return response.nextBin;
}

import Medusa from '@medusajs/medusa-js';
import dotenv from 'dotenv';
import type { Metadata } from '../models/setInfo';
import type { ProductVariant } from '../models/cards';
import type {
  DecoratedInventoryItemDTO,
  InventoryItemDTO,
  MoneyAmount,
  PricedProduct,
  PricedVariant,
  Product,
  ProductCategory,
} from '@medusajs/client-types';

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

export async function createProduct(product: Product): Promise<Product> {
  const response = await medusa.admin.products.create({
    title: product.title,
    description: product.description as string,
    weight: product.weight as number,
    length: product.length as number,
    width: product.width as number,
    height: product.height as number,
    origin_country: product.origin_country as string,
    material: product.material as string,
    // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
    metadata: product.metadata,
    categories: [{ id: product.categories?.[0].id || '' }],
    tags: product.metadata?.features,
    variants: [
      {
        title: 'base',
        sku: product.metadata?.sku,
        manage_inventory: true,
        prices: [{ currency_code: 'usd', amount: 99 }],
      },
    ],
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function updateProductImages(product: { id: string; images: string[] }): Promise<Product> {
  const response = await medusa.admin.products.update(product.id, {
    images: product.images,
  });
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
        prices: productVariant.prices.map((price) =>
          typeof price.amount === 'string' ? { ...price, amount: parseInt(price.amount) } : price,
        ),
      });
    } catch (e) {
      // @ts-expect-error cannot figure out how to type case this correctly
      const message = e.response?.data?.message || e.message;
      throw `Failed to save variant ${productVariant.id} for product ${productVariant.product.id} with prices: 
      ${JSON.stringify(productVariant.prices, null, 2)}
      Error: ${message}`;
    }
  } else {
    response = productVariant;
  }

  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.product;
}

export async function getProductCardNumbers(category: string): Promise<string[]> {
  const response = await medusa.admin.products.list({
    category_id: [category],
    fields: 'metadata',
  });
  return response.products
    ? // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
      response.products.map((product: Product | PricedProduct) => product.metadata.cardNumber)
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

export async function startSync(categoryId: string) {
  return await medusa.admin.custom.post('/sync', {
    category: categoryId,
  });
}

export async function getProductVariant(variantId: string): Promise<PricedVariant> {
  const response = await medusa.admin.variants.retrieve(variantId);
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.variant;
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
  });
  // @ts-expect-error Medusa types in the library don't match the exported types for use by clients
  return response.products;
}

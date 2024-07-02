import Medusa from '@medusajs/medusa-js';
import dotenv from 'dotenv';
import type { Category, Metadata } from '../models/setInfo';
import type { Product, ProductVariant } from '../models/cards';

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

export async function createCategory(name: string, parent_category_id: string, handle: string, metadata = {}) {
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
) {
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

export async function setCategoryActive(id: string, description: string, metadataUpdates: Metadata) {
  const response = await medusa.admin.productCategories.update(id, {
    description: description,
    is_active: true,
    is_internal: false,
    metadata: metadataUpdates,
  });
  return response.product_category;
}

export async function updateCategory(id: string, metadataUpdates: Metadata) {
  const response = await medusa.admin.productCategories.update(id, { metadata: metadataUpdates });
  return response.product_category || {};
}

export async function getRootCategory() {
  const { product_categories } = await medusa.admin.productCategories.list({ handle: 'root' });
  return product_categories[0].id;
}

export async function getCategories(parent_category_id: string) {
  const response = await medusa.admin.productCategories.list({
    parent_category_id: parent_category_id,
    include_descendants_tree: false,
    // fields: 'name',
  });
  return response.product_categories;
}

export async function createProduct(product: Product) {
  const response = await medusa.admin.products.create({
    title: product.title,
    description: product.description,
    weight: product.weight,
    length: product.length,
    width: product.width,
    height: product.height,
    origin_country: product.origin_country,
    material: product.material,
    metadata: product.metadata,
    categories: [{ id: product.categories.id }],
    tags: product.metadata.features,
    variants: [
      {
        title: 'base',
        sku: product.metadata.sku,
        manage_inventory: true,
        prices: [{ currency_code: 'usd', amount: 99 }],
      },
    ],
  });
  return response.product;
}

export async function updateProduct(product: Product) {
  const response = await medusa.admin.products.update(product.id, {
    images: product.images,
  });
  return response.product;
}

export async function updateProductVariant(productVariant: ProductVariant) {
  if (!productVariant.prices) throw 'No prices to update';
  if (!productVariant.product) throw 'No product to update';

  const response = await medusa.admin.products.updateVariant(productVariant.product.id, productVariant.id, {
    prices: productVariant.prices,
  });
  return response.product;
}

export async function getProductCardNumbers(category: string) {
  const response = await medusa.admin.products.list({
    category_id: [category],
    fields: 'metadata',
  });
  return response.products ? response.products.map((product: Product) => product.metadata.cardNumber) : [];
}

type RegionCache = { [key: string]: string };
let regionCache: RegionCache;

export async function getRegion(regionName: string) {
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
  // const response = medusa.admin.batchJobs.create({
  //   type: 'publish-products',
  //   context: { categoryId },
  //   dry_run: true,
  // });
}

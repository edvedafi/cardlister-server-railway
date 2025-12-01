import type { Product, ProductCategory } from '@medusajs/client-types';

export type Metadata = {
  [key: string]: unknown;
  features?: string[];
  _perfectMatch?: boolean;
  _bestMatchPlayer?: string | string[];
};

export type Category = ProductCategory;

export type SetInfo = ProductCategory & {
  year: Category;
  brand: Category;
  sport: Category;
  set: Category;
  variantType: Category;
  variantName: Category;
  category: Category;
  products?: Product[];
};

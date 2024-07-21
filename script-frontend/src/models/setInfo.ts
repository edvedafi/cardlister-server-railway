import type { Product } from './cards';
import type { ProductCategory } from '@medusajs/client-types';

export type Metadata = {
  [key: string]: any;
};

export type Category = ProductCategory;

export type SetInfo = Category & {
  year: Category;
  brand: Category;
  sport: Category;
  set: Category;
  variantType: Category;
  variantName: Category;
  category: Category;
  products?: Product[];
};

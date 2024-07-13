import type {Product} from "./cards";

export type Metadata = {
  [key: string]: any;
};

export type Category = {
  metadata: Metadata;
  handle: string;
  name: string;
  id: string;
  description: string;
  is_active: boolean;
};

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

import { type Category } from './setInfo';

export type SLCard = {
  cardNumber: string;
  title: string;
};

export type Product = {
  id: string;
  type: string;
  categories: Category;
  weight: number;
  length: number;
  width: number;
  height: number;
  depth?: number;
  origin_country: string;
  material: string;
  title?: string;
  description?: string;
  size?: string;
  thickness?: string;
  lbs?: number;
  oz?: number;
  images?: string[];
  metadata: {
    cardNumber: string;
    player: string[];
    teams: string;
    sku: string;
    size: string;
    thickness: string;
    bsc?: string;
    sportlots?: string;
    cardName?: string;
    printRun?: string;
    autograph?: string;
    autographed?: boolean;
    features?: string;
  };
};

export type ProductVariant = {
  id: string;
  title: string;
  sku: string;
  product?: Product;
  prices: {
    currency_code: string;
    amount: number;
  }[];
};

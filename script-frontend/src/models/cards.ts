import { type Category } from './setInfo';
import type { Card } from './bsc';

export type SLCard = {
  cardNumber: string;
  title: string;
};

export type Prices = {
  amount: number;
  region_id: string;
};

export type ProductImage = {
  file: string;
  url: string;
};

export type Product = {
  id: string;
  handle: string;
  type: string;
  categories: Category[];
  weight: number;
  length: number;
  width: number;
  height: number;
  depth?: number;
  origin_country: string;
  material: string;
  title: string;
  description: string;
  size: string;
  thickness?: string;
  lbs?: number;
  oz?: number;
  images: ProductImage[];
  variants: ProductVariant[];
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

export type Inventory = {
  id: string;
};

export type CropHints = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type ImageRecognitionResults = Card &
  SLCard & {
    crop?: CropHints;
    cropBack?: CropHints;
    sport?: string;
    brand?: string;
    raw?: string[];
    player?: string;
    team?: string;
    cardNumber?: string;
  };

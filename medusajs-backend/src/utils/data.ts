import { IInventoryService } from '@medusajs/types';
import { ProductVariant } from '@medusajs/medusa';
import fs from 'node:fs';
import axios from 'axios';

export const isYes = (str: string | boolean | unknown): boolean =>
  (typeof str === 'boolean' && str) ||
  (typeof str === 'string' && ['yes', 'YES', 'y', 'Y', 'Yes', 'YEs', 'YeS', 'yES'].includes(str));

export const isNo = (str: string | boolean | unknown): boolean =>
  (typeof str === 'boolean' && !str) || (typeof str === 'string' && ['no', 'NO', 'n', 'N', 'No'].includes(str));

export const titleCase = (str: string): string =>
  str
    ? str
        .trim()
        .split(' ')
        .map((word) => {
          if (word.length > 3 && word.toLowerCase().startsWith('mc')) {
            return 'Mc' + word[2].toUpperCase() + word.slice(3).toLowerCase();
          } else {
            return word[0].toUpperCase() + word.slice(1).toLowerCase();
          }
        })
        .join(' ')
        .split('.')
        .map((word) => word[0]?.toUpperCase() + word.slice(1))
        .join('.')
        .split("'")
        .map((word) => word[0]?.toUpperCase() + word.slice(1))
        .join("'")
    : '';

export const getAvailableQuantity = async (
  sku: string,
  inventoryModule: IInventoryService,
  stockLocation: string,
): Promise<number> => {
  const [inventoryItems] = await inventoryModule.listInventoryItems({ sku });
  const quantityFromService = await inventoryModule.retrieveAvailableQuantity(inventoryItems[0].id, [stockLocation]);
  return isNaN(quantityFromService) ? 0 : quantityFromService;
};

export const getRegionPrice = (variant: ProductVariant, regionId: string): number =>
  (variant?.prices?.find((p) => p.region_id === regionId)?.amount || 0) / 100;

export async function downloadFile(url: string, outputPath: string) {
  const writer = fs.createWriteStream(outputPath);

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

export function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname; // Get the hostname from the URL
    return hostname.replace(/^www\./, '').split('.')[0]; // Remove 'www.' and extract the main domain part
  } catch (error) {
    console.error('Invalid URL:', error);
    return null;
  }
}

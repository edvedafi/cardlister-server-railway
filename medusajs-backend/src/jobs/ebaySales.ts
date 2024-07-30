import { Logger, ProductService, ProductVariantService, ScheduledJobArgs, ScheduledJobConfig } from '@medusajs/medusa';
import { login as ebayLogin } from '../utils/ebayAPI';

export default async function getEbaySales({ container }: ScheduledJobArgs) {
  const productService: ProductService = container.resolve('productService');
  const productVariantService: ProductVariantService = container.resolve('productVariantService');
  const logger: Logger = container.resolve('logger');
}

export const config: ScheduledJobConfig = {
  name: 'ebay-sales',
  schedule: '0 0 0 0 5', // Every day at midnight
};

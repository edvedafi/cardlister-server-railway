import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy from './AbstractListingStrategy';
import axios, { AxiosInstance } from 'axios';

class TestListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'test-strategy';
  static batchType = 'test-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(api: AxiosInstance, category: ProductCategory): Promise<void> {
    //TODO Need to Implement
  }

  async login(): Promise<AxiosInstance> {
    return axios.create({});
  }

  async syncProduct(
    eBay: AxiosInstance,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<number> {
    this.log(`Would be setting Quantity to ${quantity} and Price to ${price} for ${product.title} - ${variant.sku}`);
    return quantity;
  }
}

export default TestListingStrategy;

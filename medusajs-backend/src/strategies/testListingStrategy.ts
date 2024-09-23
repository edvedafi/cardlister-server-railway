import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy, { ListAttempt } from './AbstractListingStrategy';
import axios, { AxiosInstance } from 'axios';

class TestListingStrategy extends AbstractListingStrategy<AxiosInstance> {
  static identifier = 'test-strategy';
  static batchType = 'test-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(api: AxiosInstance, category: ProductCategory): Promise<void> {
    //TODO Need to Implement
  }

  async login() {
    return axios.create();
  }

  async removeProduct(
    connection: AxiosInstance,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
  ): Promise<ListAttempt> {
    return { skipped: true };
  }

  async syncProduct(
    api: AxiosInstance,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    this.log(`Would be setting Quantity to ${quantity} and Price to ${price} for ${variant.title} - ${variant.sku}`);
    return { skipped: true };
  }
}

export default TestListingStrategy;

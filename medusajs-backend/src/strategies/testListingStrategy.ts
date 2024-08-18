import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy from './AbstractListingStrategy';

class TestListingStrategy extends AbstractListingStrategy<WebdriverIO.Browser> {
  static identifier = 'test-strategy';
  static batchType = 'test-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(api: WebdriverIO.Browser, category: ProductCategory): Promise<void> {
    //TODO Need to Implement
  }

  async login() {
    return this.loginWebDriver('https://www.medusajs.com/');
  }

  async syncProduct(
    eBay: WebdriverIO.Browser,
    product: Product,
    variant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<number> {
    this.log(`Would be setting Quantity to ${quantity} and Price to ${price} for ${variant.title} - ${variant.sku}`);
    return quantity;
  }
}

export default TestListingStrategy;

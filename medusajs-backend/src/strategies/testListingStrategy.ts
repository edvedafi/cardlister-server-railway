import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy from './AbstractListingStrategy';
import axios, { AxiosInstance } from 'axios';
import process from "node:process";

class TestListingStrategy extends AbstractListingStrategy<WebdriverIO.Browser> {
  static identifier = 'test-strategy';
  static batchType = 'test-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(api: WebdriverIO.Browser, category: ProductCategory): Promise<void> {
    //TODO Need to Implement
  }

  async login() {
    const browser = await this.loginWebDriver('https://www.mycardpost.com/');

    await browser.url('login');
    await browser.$('input[type="email"]').setValue(process.env.MCP_EMAIL);
    await browser.$('input[type="password"]').setValue(process.env.MCP_PASSWORD);
    await browser.$('button=Login').click();

    let toast: WebdriverIO.Element;
    try {
      toast = await browser.$('.toast-message');
    } catch (e) {
      // no toast so all is good
    }
    if (toast && (await toast.isDisplayed())) {
      const resultText = await toast.getText();
      if (resultText.indexOf('Invalid Credentials') > -1) {
        throw new Error('Invalid Credentials');
      }
    }

    await browser.url('edvedafi?tab=shop');

    return browser;
  }

  async syncProduct(
    eBay: WebdriverIO.Browser,
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

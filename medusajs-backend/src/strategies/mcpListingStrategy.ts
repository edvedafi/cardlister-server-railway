import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import process from 'node:process';
import AbstractListingStrategy from './AbstractListingStrategy';
import axios from 'axios';
import JSZip from 'jszip';

class McpListingStrategy extends AbstractListingStrategy<WebdriverIO.Browser> {
  static identifier = 'mcp-strategy';
  static batchType = 'mcp-sync';
  static listingSite = 'MCP';
  requireImages = true;

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
    mcp: WebdriverIO.Browser,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<number> {
    await mcp.url('edvedafi?tab=shop');
    const search = await mcp.$('input[type="text"][placeholder="Search Cards"]');
    await search.clearValue();
    await search.setValue(`[${productVariant.sku}]`);
    await mcp.pause(1000);

    const countFiled = await mcp.$('h2.card-count');
    let siteCount = parseInt((await countFiled.getText()).replace(/[^0-9]/g, ''));

    const searchToBe = async (expectedCount: number): Promise<void> => {
      await countFiled.waitUntil(
        async () => {
          await search.setValue(`[${productVariant.sku}]`);
          const countText = await mcp.$('h2.card-count').getText();
          if (expectedCount === parseInt(countText.replace(/[^0-9]/g, ''))) {
            return true;
          } else {
            //adding a bunch of stupid pauses to try to get MCP to react properly
            await search.setValue('xxxxx');
            await mcp.pause(1000);
            await search.setValue(`[${productVariant.sku}]`);
            return false;
          }
        },
        { timeout: 10000, interval: 1000 },
      );
    };

    const deleteCard = async () => {
      await mcp.$('=Delete').click();
      const confirm = await mcp.$('#delete-btn');
      await confirm.waitForClickable({ timeout: 10000 });
      await confirm.click();
      siteCount--;
      await searchToBe(siteCount);
    };

    //should never have more than one card with the same sku
    while (siteCount > 1) {
      await deleteCard();
    }

    //if quantity is 0, remove the product from MCP if necessary
    if (quantity === 0) {
      if (siteCount > 0) {
        await deleteCard();
        this.log(`Removed ${productVariant.sku} from MCP`);
        return 1;
      } else {
        this.log(`${productVariant.sku} not found on MCP; wanted to delete so all good`);
        return 0;
      }
    } else {
      if (siteCount === 0) {
        await mcp.$('button=Add Card').click();
        const form = await mcp.$('//form[@action="https://mycardpost.com/add-card"]');
        const frontImage = await this.tempImage(product.images[0].url, mcp);
        await form.$('#front_image').setValue(frontImage);
        const backImage = await this.tempImage(product.images[1].url, mcp);
        await form.$('#back_image').setValue(backImage);
        await form.$('textarea[name="name"]').setValue(`${product.title} [${productVariant.sku}]`);
        await form.$('input[name="price"]').setValue(price);
        await form.$('select[name="sport"]').selectByVisibleText(category.metadata.sport as string);
        for (const team of product.metadata.teams as string[]) {
          await form.$(`//span[@role='textbox' and @data-placeholder='Type something']`).setValue(team);
        }
        const typeSelect = await form.$('#card_type');
        // TODO this doesn't exist yet
        // if (productVariant.metadata.graded) {
        //   await typeSelect.selectByVisibleText('Graded');
        //   await form.$('#professional_grader').setValue(productVariant.metadata.grader as string);
        //   await form.$('#grade').setValue(productVariant.metadata.grade as string);
        // } else {
        await typeSelect.selectByVisibleText('Raw');
        // }
        const features: string[] = (product.metadata.features as string[])?.map((f) => f.toLowerCase()) || [];
        const featureInput = await form.$('#attribute_name');
        if (features.includes('rc')) {
          await featureInput.selectByVisibleText('Rookie');
        }
        if (product.metadata.printRun > 0) {
          await featureInput.selectByVisibleText('Serial Numbered');
          if (product.metadata.printRun === 1) {
            await featureInput.selectByVisibleText('1/1');
          }
        }
        if (product.metadata.autographed) {
          await featureInput.selectByVisibleText('Autograph');
        }
        if (features.includes('jersey') || features.includes('patch')) {
          await featureInput.selectByVisibleText('Patch');
          await featureInput.selectByVisibleText('Memorabilia');
        }
        if (features.includes('mem')) {
          await featureInput.selectByVisibleText('Memorabilia');
        }
        if (features.includes('sp') || features.includes('sport print') || features.includes('variation')) {
          await featureInput.selectByVisibleText('Short Print');
        }
        if (category.metadata.insert) {
          await featureInput.selectByVisibleText('Insert');
        }
        if (category.metadata.parallel) {
          await featureInput.selectByVisibleText('Parallel');
          if ((category.metadata.parallel as string).indexOf('refractor')) {
            await featureInput.selectByVisibleText('Refractor');
          }
        }
        if (features.includes('case')) {
          await featureInput.selectByVisibleText('Case Hit');
        }
        if (category.metadata.year < 1980) {
          await featureInput.selectByVisibleText('Vintage');
        }
        if (features.includes('jersey number')) {
          await featureInput.selectByVisibleText('Jersey Numbered');
        }

        await form.$('textarea[name="details"').setValue(`${product.description}\n\n[${productVariant.sku}]`);

        await form.$('button.yellow-btn').click();

        const toast = await mcp.$('.toast-message');
        await toast.waitForExist({ timeout: 30000 });
        const resultText = await toast.getText();
        await toast.waitForExist({ reverse: true, timeout: 10000 });
        if (resultText.indexOf('Successful') > -1) {
          this.log(`${productVariant.sku} listed on MCP`);
          return 1;
        } else {
          throw new Error(`${productVariant.sku} failed to list on MCP::${resultText}`);
        }
      } else {
        this.log(`${productVariant.sku} already listed properly on MCP`);
        return 0;
      }
    }
  }

  async tempImage(imageName: string, browser: WebdriverIO.Browser): Promise<string> {
    const response = await axios.get(
      `https://firebasestorage.googleapis.com/v0/b/hofdb-2038e.appspot.com/o/${imageName}?alt=media`,
      { responseType: 'arraybuffer' },
    );
    const imageBuffer = Buffer.from(response.data, 'binary');

    const zip = new JSZip();
    zip.file(imageName, imageBuffer);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    return await browser.file(zipBuffer.toString('base64'));
  }
}

export default McpListingStrategy;

import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy from './AbstractListingStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login } from '../utils/mcp';

class McpListingStrategy extends AbstractListingStrategy<PuppeteerHelper> {
  static identifier = 'mcp-strategy';
  static batchType = 'mcp-sync';
  static listingSite = 'MCP';
  requireImages = true;

  async login() {
    return await this.loginPuppeteer('https://mycardpost.com/', login);
  }

  async syncProduct(
    pup: PuppeteerHelper,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<number> {
    await pup.goto('edvedafi?tab=shop');
    const searchField = pup.locator('input[type="text"][placeholder="Search Cards"]');
    await searchField.fill(`[${productVariant.sku}]`);
    await new Promise((r) => setTimeout(r, 1000));

    let siteCount = parseInt((await pup.getText('h2.card-count')).replace(/[^0-9]/g, ''));

    const searchToBe = async (expectedCount: string): Promise<void> => {
      try {
        pup.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
        await searchField.fill(`[${productVariant.sku}]`);
        await pup.page.waitForFunction(
          (expectedCount: string) =>
            expectedCount ===
            document
              .querySelector('h2.card-count')
              ?.textContent.replace(/[^0-9]/g, '')
              .trim(),
          { timeout: 30000 },
          expectedCount,
        );
      } catch (e) {
        console.log(e);
        await pup.screenshot('search-text-timeout');
        throw new Error(`Expected ${expectedCount} cards with SKU ${productVariant.sku} but found ${siteCount}`);
      }
    };

    const deleteCard = async () => {
      await (await pup.el({ locator: 'a', text: 'Delete' })).click();
      await pup.locator('#delete-btn').click();
      siteCount--;
      await searchToBe('0');
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
        await pup.locatorText('button', 'Add Card').click();
        // const form = await pup.$('form[@action="https://mycardpost.com/add-card"]');
        await pup.uploadImage(<string>productVariant.metadata.frontImage, 'front_image');
        await pup.uploadImage(<string>productVariant.metadata.backImage, 'back_image');
        await pup.screenshot('images-uploaded');
        await pup.locator('textarea[name="name"]').fill(`${productVariant.title} [${productVariant.sku}]`);
        await pup.locator('input[name="price"]').fill(`${price}`);
        await pup.select('select[name="sport"]', <string>category.metadata.sport);
        for (const team of productVariant.metadata.teams as string[]) {
          await (await pup.$(`span[role='textbox'][data-placeholder='Type something']`)).type(team);
        }

        // TODO this doesn't exist yet
        // if (productVariant.metadata.graded) {
        //   await pup.select('#card_type', 'Graded');
        //   await pup.locator('#professional_grader').fill(productVariant.metadata.grader as string);
        //   await pup.locator('#grade').fill(productVariant.metadata.grade as string);
        // } else {
        await pup.select('#card_type', '2'); //Raw
        // }
        const features: string[] = (productVariant.metadata.features as string[])?.map((f) => f.toLowerCase()) || [];
        const selectValues: string[] = [];

        if (features.includes('rc')) {
          selectValues.push('Rookie');
        }
        if (<number>productVariant.metadata.printRun > 0) {
          selectValues.push('Serial Numbered');
          if (<number>productVariant.metadata.printRun === 1) {
            selectValues.push('1/1');
          }
        }
        if (productVariant.metadata.autographed) {
          selectValues.push('Autograph');
        }
        if (features.includes('jersey') || features.includes('patch')) {
          selectValues.push('Patch');
          selectValues.push('Memorabilia');
        }
        if (features.includes('mem')) {
          selectValues.push('Memorabilia');
        }
        if (features.includes('sp') || features.includes('sport print') || features.includes('variation')) {
          selectValues.push('Short Print');
        }
        if (category.metadata.insert) {
          selectValues.push('Insert');
        }
        if (category.metadata.parallel) {
          selectValues.push('Parallel');
          if ((category.metadata.parallel as string).indexOf('refractor')) {
            selectValues.push('Refractor');
          }
        }
        if (features.includes('case')) {
          selectValues.push('Case Hit');
        }
        if (<number>category.metadata.year < 1980) {
          selectValues.push('Vintage');
        }
        if (features.includes('jersey number')) {
          selectValues.push('Jersey Numbered');
        }
        await pup.select('#attribute_name', selectValues);

        await pup
          .locator('textarea[name="details"')
          .fill(`${productVariant.metadata.description}\n\n[${productVariant.sku}]`);

        await pup.locator('button.yellow-btn').click();

        try {
          await searchToBe('1');
          this.log(`${productVariant.sku} listed on MCP`);
          return 1;
        } catch (e) {
          this.log(`${productVariant.sku} failed to list on MCP`, e);
          return 0;
        }
      } else {
        this.log(`${productVariant.sku} already listed properly on MCP`);
        return 0;
      }
    }
  }
}

export default McpListingStrategy;

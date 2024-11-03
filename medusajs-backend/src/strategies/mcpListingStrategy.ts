import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy, { ListAttempt } from './AbstractListingStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login } from '../utils/mcp';
import * as console from 'node:console';

class McpListingStrategy extends AbstractListingStrategy<PuppeteerHelper> {
  static identifier = 'mcp-strategy';
  static batchType = 'mcp-sync';
  static listingSite = 'MCP';
  requireImages = true;

  async login() {
    return await this.loginPuppeteer('https://mycardpost.com/', login);
  }

  async searchToBe(pup: PuppeteerHelper, productVariant: ProductVariant, expectedCount: string): Promise<void> {
    try {
      await pup.waitForURL('edvedafi?tab=shop', 30000);
      await pup.fill('input[type="text"][placeholder="Search Cards"]', `[${productVariant.sku}]`);
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
      throw new Error(`Failed waiting to find ${expectedCount} cards with SKU ${productVariant.sku}`);
    }
  }

  async removeProduct(pup: PuppeteerHelper, product: Product, productVariant: ProductVariant): Promise<ListAttempt> {
    await pup.goto('edvedafi?tab=shop');
    await pup.page.evaluate(async (sku) => {
      (<HTMLInputElement>document.querySelector('input[type="text"][placeholder="Search Cards"]')).value = sku;

      let deleteButton = document.querySelectorAll('a[onclick^="deleteItem"]');
      if (deleteButton.length > 1) {
        console.log(`Found ${deleteButton.length} delete buttons`);
        await new Promise((r) => setTimeout(r, 3000));
        deleteButton = document.querySelectorAll('a[onclick^="deleteItem"]');
      }
      deleteButton.forEach((el: HTMLButtonElement) => {
        el.click();
        (<HTMLButtonElement>document.querySelector('#delete-btn')).click();
      });
    }, `[${productVariant.sku}]`);

    await this.searchToBe(pup, productVariant, '0');
    return { quantity: 1 };
  }

  async syncProduct(
    pup: PuppeteerHelper,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    await pup.goto('edvedafi?tab=shop');
    await pup.locator('input[type="text"][placeholder="Search Cards"]').fill(`[${productVariant.sku}]`);
    await new Promise((r) => setTimeout(r, 500));

    const siteCount = parseInt((await pup.getText('h2.card-count')).replace(/[^0-9]/g, ''));
    if (siteCount === 1) return { skipped: true };

    // await pup.screenshot('before-add-card');
    await pup.locatorText('button', 'Add Card').click();

    // const form = await pup.$('form[@action="https://mycardpost.com/add-card"]');
    await pup.page.waitForSelector('form[action="https://mycardpost.com/add-card"]', { timeout: 30000, visible: true });
    await pup.uploadImageBase64(<string>productVariant.metadata.frontImage, 'front_image');
    await pup.uploadImageBase64(<string>productVariant.metadata.backImage, 'back_image');
    // await pup.screenshot('images-uploaded');
    // console.log(`setting name to ${productVariant.title} [${productVariant.sku}]`);

    const features: string[] = (productVariant.metadata.features as string[])?.map((f) => f.toLowerCase()) || [];
    const featureSelectOptions: string[] = [];

    if (features.includes('rc')) {
      featureSelectOptions.push('Rookie');
      featureSelectOptions.push('45');
    }
    if (<number>productVariant.metadata.printRun > 0) {
      featureSelectOptions.push('Serial Numbered');
      featureSelectOptions.push('88');
      if (<number>productVariant.metadata.printRun === 1) {
        featureSelectOptions.push('1/1');
        featureSelectOptions.push('42');
      }
    }
    if (productVariant.metadata.autographed) {
      featureSelectOptions.push('Autograph');
      featureSelectOptions.push('84');
    }
    if (features.includes('jersey') || features.includes('patch')) {
      featureSelectOptions.push('Patch');
      featureSelectOptions.push('214');
      featureSelectOptions.push('Memorabilia');
      featureSelectOptions.push('43');
    }
    if (features.includes('mem')) {
      featureSelectOptions.push('Memorabilia');
    }
    if (
      features.includes('ssp') ||
      features.includes('sp') ||
      features.includes('sport print') ||
      features.includes('variation')
    ) {
      featureSelectOptions.push('Short Print');
      featureSelectOptions.push('46');
    }
    if (category.metadata.insert) {
      featureSelectOptions.push('Insert');
      featureSelectOptions.push('215');
    }
    if (category.metadata.parallel) {
      featureSelectOptions.push('Parallel');
      featureSelectOptions.push('331');
      if ((<string>category.metadata.parallel).toLowerCase().includes('refractor')) {
        featureSelectOptions.push('Refractor');
        featureSelectOptions.push('213');
      }
      if ((<string>category.metadata.parallel).toLowerCase().includes('foil')) {
        featureSelectOptions.push('Foil');
        featureSelectOptions.push('2456');
      }
    }
    if (features.includes('case') || features.includes('case hit') || features.includes('ssp')) {
      featureSelectOptions.push('Case Hits');
      featureSelectOptions.push('383');
    }
    if (<number>category.metadata.year < 1980) {
      featureSelectOptions.push('Vintage');
      featureSelectOptions.push('520');
    }
    if (features.includes('jersey number') || features.includes('jersey numbered')) {
      featureSelectOptions.push('Jersey Numbered');
      featureSelectOptions.push('355');
    }

    await pup.page.evaluate(
      (productVariant, category, price, featureSelectOptions) => {
        (<HTMLInputElement>document.querySelector('textarea[name="name"]')).value =
          `${productVariant.title} [${productVariant.sku}]`;

        (<HTMLInputElement>document.querySelector('input[name="price"]')).value = `${price}`;

        (<string[]>productVariant.metadata.teams).forEach((team) => {
          (<HTMLInputElement>document.querySelector('span[role="textbox"][data-placeholder="Type something"]')).value =
            team;
        });

        const sportSelect: HTMLSelectElement = document.querySelector('select[name="sport"]');
        const sport = (<string>category.metadata.sport).toLowerCase();
        sportSelect.value = Array.from(sportSelect.options).find(
          (option) => option.text.trim().toLowerCase() === sport,
        ).value;
        sportSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const cardTypeSelect: HTMLSelectElement = document.querySelector('select[name="card_type"]');
        cardTypeSelect.value = '2'; //Raw
        cardTypeSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const featureSelectElement: HTMLSelectElement = document.querySelector('#attribute_name');
        // Set selected property for each option
        Array.from(featureSelectElement.options).forEach((option) => {
          option.selected = featureSelectOptions.includes(option.value);
        });
        featureSelectElement.dispatchEvent(new Event('change', { bubbles: true }));

        (<HTMLTextAreaElement>document.querySelector('textarea[name="details"]')).value =
          `${productVariant.metadata.description}\n\n[${productVariant.sku}]`;

        (<HTMLButtonElement>document.querySelector('button.yellow-btn')).click();
      },
      productVariant,
      category,
      price,
      featureSelectOptions,
    );

    let errorField: string;
    try {
      errorField = await pup.getAttribute('.error', 'name');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      // console.log(`No Errors Found: ${e.message}`);
    }
    if (errorField) {
      return { error: `Field Error: ${errorField} = ${await pup.getText(`input[name=${errorField}]`)}` };
    }

    await pup.locatorFound('#swal2-title', 'Adding Card...', true);

    try {
      await this.searchToBe(pup, productVariant, '1');
      this.log(`${productVariant.sku} listed on MCP`);
    } catch (e) {
      return { error: e.message };
    }
    return { quantity: 1 };
  }
}

export default McpListingStrategy;

import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import AbstractListingStrategy, { SyncResult } from './AbstractListingStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login as slLogin } from '../utils/sportlots';

class SportlotsListingStrategy extends AbstractListingStrategy<PuppeteerHelper> {
  static identifier = 'sportlots-strategy';
  static batchType = 'sportlots-sync';
  static listingSite = 'SportLots';

  async login() {
    return await this.loginPuppeteer('https://www.sportlots.com/', slLogin);
  }

  async removeAllInventory(pup: PuppeteerHelper, category: ProductCategory): Promise<void> {
    if (category.metadata.sportlots) {
      await pup.goto(`inven/dealbin/setdetail.tpl?Set_id=${category.metadata.sportlots}`);
      const waitForAlert = pup.acceptAlert();
      await pup.locator('input[value="Delete All Set Inventory"').click();
      await waitForAlert;
    }
  }

  async loadAddInventoryScreen(
    pup: PuppeteerHelper,
    year: string,
    brand: string,
    sport: string,
    bin: string,
  ): Promise<void> {
    try {
      await pup.goto('inven/dealbin/newinven.tpl');
      await pup.page.select('select[name="yr"]', year);
      await pup.page.select('select[name="brd"]', brand);
      await pup.page.select(
        'select[name="sprt"]',
        {
          baseball: 'BB',
          football: 'FB',
          basketball: 'BK',
        }[sport.toLowerCase()],
      );
      await pup.locator('input[name="dbin"]').fill(`${bin}`);
      await pup.locator('input[type="radio"][name="pricing"][value="NEW"]').click();
      await pup.locator('input[value="Next"]').click();
    } catch (e) {
      await pup.screenshot('load-inventory-error');
      throw e;
    }
  }

  async selectSet(pup: PuppeteerHelper, setId: string) {
    try {
      await pup.waitForURL('dealsets.tpl');
      await pup.locator(`input[name="selset"][value="${setId}"]`).click();
      await pup.locator('input[value="Get Cards"').click();
      await pup.waitForURL('listcards.tpl');
    } catch (e) {
      await pup.screenshot('select-set-error');
      throw e;
    }
  }

  async syncProducts(
    pup: PuppeteerHelper,
    products: Product[],
    category: ProductCategory,
    advanceCount: (count: number) => Promise<number>,
  ): Promise<SyncResult> {
    if (!category.metadata.sportlots) return { success: 0 };
    try {
      let count = 0;
      await this.loadAddInventoryScreen(
        pup,
        category.metadata.year as string,
        category.metadata.brand as string,
        category.metadata.sport as string,
        category.metadata.bin as string,
      );

      await this.selectSet(pup, category.metadata.sportlots as string);

      const processPage = async (): Promise<SyncResult> => {
        let expectedAdds = 0;

        const tableBody = await pup.$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody');
        const rows = await tableBody.$$('tr:has(td):not(:has(th))');

        for (const row of rows) {
          // console.log('Processing row', await pup.getText(row));
          const cardNumberCell = await row.$('td:nth-child(2)');
          const cardNumber = await pup.getText(cardNumberCell);
          const product = products.find((p) => p.metadata.cardNumber.toString() === cardNumber);

          const isVariation = await pup.hasClass(row, 'variation');
          const title = await pup.getText(row.$('td:nth-child(3)'));
          let variant: ProductVariant | undefined;
          if (isVariation || title.match(/\[.*VAR.*]/)) {
            variant = product?.variants.find((v) => v.metadata.sportlots === title);
          } else if (product?.variants.length == 1) {
            variant = product?.variants[0];
          } else {
            variant = product?.variants.find((v) => v.metadata.isBase);
          }
          if (variant) {
            const quantity = await this.getQuantity({ variant });

            if (quantity > 0) {
              this.log(`Adding ${quantity} of ${cardNumber} at ${this.getPrice(variant)}`);
              await pup.fill(row.$('td:nth-child(1) > input'), `${quantity}`);
              await pup.fill(row.$('td:nth-child(4) > input'), this.getPrice(variant).toString());
              expectedAdds += quantity;
            } else {
              this.log(`No quantity for ${cardNumber}`);
            }
          } else {
            //TODO Need to handle this in a recoverable way
            this.log(`variant not found ${cardNumber}`);
          }
          count = await advanceCount(count);
        }

        await pup.screenshot('add-inventory');
        await pup.locator('input[value="Inventory Cards"').click();
        await pup.locator('h2.message').wait();
        const banner = await pup.getText('h2.message');
        let resultCount = parseInt(banner.replace('  cards added', ''));
        if (resultCount == expectedAdds) {
          this.log('Set Successfully added:' + expectedAdds);
        } else {
          throw new Error(`sportlots::Failed. Uploaded ${resultCount} cards but expected ${expectedAdds} cards.`);
        }

        if (await pup.hasText('td', 'Skip to Page:')) {
          resultCount += (await processPage()).success;
        }
        return { success: resultCount };
      };
      //process at least once
      return await processPage();
    } catch (e) {
      console.log('Sync Error', e);
      await pup.screenshot('sync-error');
      throw e;
    }
  }
}

export default SportlotsListingStrategy;

import { Product, ProductCategory } from '@medusajs/medusa';
import process from 'node:process';
import ListingStrategy from './ListingStrategy';

class SportlotsStrategy extends ListingStrategy<WebdriverIO.Browser> {
  static identifier = 'sportlots-strategy';
  static batchType = 'sportlots-sync';
  static listingSite = 'SportLots';

  async login() {
    const browser = await this.loginWebDriver('https://www.sportlots.com/');

    await browser.url('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
    await browser.$('input[name="email_val"]').setValue(process.env.SPORTLOTS_ID);
    await browser.$('input[name="psswd"]').setValue(process.env.SPORTLOTS_PASS);
    await browser.$('input[value="Sign-in"]').click();
    return browser;
  }

  async removeAllInventory(browser: WebdriverIO.Browser, category: ProductCategory): Promise<void> {
    await browser.url(`inven/dealbin/setdetail.tpl?Set_id=${category.metadata.sportlots}`);
    await browser.$('input[value="Delete All Set Inventory"').click();
    await browser.waitUntil(
      async () => {
        try {
          await browser.getAlertText();
          return true;
        } catch (e) {
          return false;
        }
      },
      {
        timeout: 5000, // Adjust the timeout as needed
        timeoutMsg: 'Alert did not appear within the timeout',
      },
    );
    await browser.acceptAlert();
  }

  async loadAddInventoryScreen(
    browser: WebdriverIO.Browser,
    year: string,
    brand: string,
    sport: string,
    bin: string,
  ): Promise<void> {
    await browser.url('inven/dealbin/newinven.tpl');
    await browser.$('select[name="yr"]').selectByAttribute('value', year);
    await browser.$('select[name="brd"]').selectByAttribute('value', brand);
    await browser.$('select[name="sprt"]').selectByAttribute(
      'value',
      {
        baseball: 'BB',
        football: 'FB',
        basketball: 'BK',
      }[sport.toLowerCase()],
    );
    await browser.$('input[name="dbin"]').setValue(bin);
    await browser.$('input[type="radio"][name="pricing"][value="NEW"]').click();
    await browser.$('input[value="Next"]').click();
  }

  async selectSet(browser: WebdriverIO.Browser, setId: string) {
    await browser.waitUntil(async () => (await browser.getUrl()).match(/dealsets.tpl/));
    await browser.$(`input[name="selset"][value="${setId}"]`).click();
    await browser.$('input[value="Get Cards"').click();
  }

  async syncProducts(browser: WebdriverIO.Browser, products: Product[], category: ProductCategory): Promise<number> {
    await this.loadAddInventoryScreen(
      browser,
      category.metadata.year as string,
      category.metadata.brand as string,
      category.metadata.sport as string,
      category.metadata.bin as string,
    );

    await this.selectSet(browser, category.metadata.sportlots as string);

    const processPage = async (): Promise<number> => {
      let expectedAdds = 0;

      const rows = await browser
        .$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody')
        .$$('tr:has(td):not(:has(th))');
      for (const row of rows) {
        const cardNumber = await row.$('td:nth-child(2)').getText();
        const product = products.find((p) => p.metadata.cardNumber.toString() === cardNumber);
        const variant = product?.variants[0]; //TODO This will need to handle multiple variants
        if (variant) {
          const quantity = await this.getQuantity({ variant });

          if (quantity > 0) {
            await row.$('td:nth-child(1) > input').setValue(quantity);
            await row.$('td:nth-child(4) > input').setValue(this.getPrice(variant));
            expectedAdds += quantity;
          } else {
            this.log(`No quantity for ${cardNumber}`);
          }
        } else {
          //TODO Need to handle this in a recoverable way
          this.log(`variant not found ${cardNumber}`);
        }
      }

      await browser.saveScreenshot('sportlots-sync.png');
      await browser.$('input[value="Inventory Cards"').click();
      const banner = await browser.$('h2.message').getText();
      let resultCount = parseInt(banner.replace('  cards added', ''));
      if (resultCount == expectedAdds) {
        this.log('sportlots::Set Successfully added:' + expectedAdds);
      } else {
        throw new Error(`sportlots::Failed. Uploaded ${resultCount} cards but expected ${expectedAdds} cards.`);
      }

      //keep processing while there are more pages
      let nextPage: boolean;
      try {
        nextPage = await browser.$('td=Skip to Page:').isExisting();
      } catch (e) {
        nextPage = false;
      }
      if (nextPage) {
        resultCount += await processPage();
      }
      return resultCount;
    };

    //process at least once
    return await processPage();
  }
}

export default SportlotsStrategy;

import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import process from 'node:process';

abstract class SportlotsSalesStrategy extends SaleStrategy<WebdriverIO.Browser> {
  static identifier = 'sportlots-sales-strategy';
  static batchType = 'sportlots-sales-sync';
  static listingSite = 'SportLots';

  async login() {
    const browser = await this.loginWebDriver('https://www.sportlots.com/');

    await browser.url('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
    await browser.$('input[name="email_val"]').setValue(process.env.SPORTLOTS_ID);
    await browser.$('input[name="psswd"]').setValue(process.env.SPORTLOTS_PASS);
    await browser.$('input[value="Sign-in"]').click();
    return browser;
  }

  async getOrders(browser: WebdriverIO.Browser): Promise<SystemOrder[]> {
    const orders: SystemOrder[] = [];

    const process = async (orderType: string) => {
      await browser.url(`inven/dealbin/dealacct.tpl?ordertype=${orderType}`);
      const orderTable = await browser.$$('form[action="/inven/dealbin/dealupd.tpl"]');
      for (const table of orderTable) {
        //its divs all the way down!
        let i = 0;
        const divs = await table.$$(`div`);
        const link = await divs[i].$('a');
        const order: SystemOrder = {
          id: await link.getText(),
          customer: {
            name: await link.getAttribute('title'),
            username: await link.getText(),
            email: (await link.getText()) + '@sportlots.com',
          },
          packingSlip: (await link.getAttribute('href')).replace("javascript:showFAQ('", '').replace("',1400,500)", ''),
          lineItems: [],
        };
        i = 15; // skip a bunch of junk
        this.log(`Processing divs: ${divs.length}`);
        while (i + 6 <= divs.length) {
          i++; //first is a blank div
          const quantity = await divs[i++]?.getText();
          const title = await divs[i++]?.getText();
          const bin = await divs[i++]?.getText();
          i++; // condition
          const price = await divs[i++]?.getText();
          const cardNumber = title
            .split(' ')
            .find((word) => word.startsWith('#'))
            .replace('#', '');
          order.lineItems.push({
            quantity: parseInt(quantity.replace('\n0', '').trim()),
            title: title,
            sku: bin.indexOf('|') > 0 ? bin : `${bin}|${cardNumber}`,
            cardNumber: cardNumber,
            unit_price: parseInt(price.replace('.', '').replace('$', '').trim()),
          });
        }
        this.log(`Found order: ${JSON.stringify(order, null, 2)}`);
        orders.push(order);
      }
    };

    await process('1a');
    await process('1b');

    return orders;
  }
}

export default SportlotsSalesStrategy;

import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import process from 'node:process';

abstract class McpSalesStrategy extends SaleStrategy<WebdriverIO.Browser> {
  static identifier = 'mcp-sales-strategy';
  static batchType = 'mcp-sales-sync';
  static listingSite = 'MCP';

  async login() {
    const browser = await this.loginWebDriver('https://mycardpost.com/');

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

    await browser.$('h2=edvedafi').waitForDisplayed();

    return browser;
  }

  async getOrders(browser: WebdriverIO.Browser): Promise<SystemOrder[]> {
    await browser.url('/orders');

    const orders: SystemOrder[] = [];
    await browser.$('input[type="radio"][value="3"][wire\\:model="order_type"]').click();
    await browser.$('h2=Shipping Address').waitForDisplayed();

    const orderTable = await browser.$$('div.orders-blk');
    for (const table of orderTable) {
      let foundTracking = false;
      try {
        foundTracking = await table.$('div.tr-id').isDisplayed();
      } catch (e) {
        // no tracking id so all is good
      }
      if (!foundTracking) {
        const orderIdLink = await table.$('a*=Order id:');
        const orderId = await orderIdLink.getText();

        const shippingContainer = browser.$('h2=Shipping Address').$('..');

        const order: SystemOrder = {
          id: orderId.substring(orderId.indexOf('#') + 1),
          customer: {
            name: await shippingContainer.$('p').getText(),
            email: (await table.$('p*=Email').getText()).split(':')[1].trim(),
            username: (await table.$('p*=Buyer').getText()).split(':')[1].trim(),
          },
          packingSlip: await orderIdLink.getAttribute('href'),
          lineItems: [],
        };

        const itemLines = await table.$('div.col-md-4').$$('p');
        for (const itemLine of itemLines) {
          const line = await itemLine.getText();
          const [title, sku] = line.split('[').map((s) => s.replace(']', '').trim());
          order.lineItems.push({
            quantity: 1,
            title: title,
            sku: sku,
            cardNumber: line
              .split(' ')
              .find((word) => word.startsWith('#'))
              ?.replace('#', '')
              .trim(),
          });
        }
        orders.push(order);
      }
    }

    this.log('Found Orders: ' + JSON.stringify(orders, null, 2));

    return orders;
  }
}

export default McpSalesStrategy;

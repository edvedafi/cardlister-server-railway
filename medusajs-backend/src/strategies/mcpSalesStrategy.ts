import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login } from '../utils/mcp';

abstract class McpSalesStrategy extends SaleStrategy<PuppeteerHelper> {
  static identifier = 'mcp-sales-strategy';
  static batchType = 'mcp-sales-sync';
  static listingSite = 'MCP';

  async login() {
    return this.loginPuppeteer('https://mycardpost.com/', login);
  }

  async getOrders(pup: PuppeteerHelper): Promise<SystemOrder[]> {
    await pup.goto('orders');

    const orders: SystemOrder[] = [];
    await pup.locator('input[type="radio"][value="3"][wire\\:model="order_type"]').click();
    await pup.locatorText('h2', 'Shipping Address').wait();

    const orderTable = await pup.$$('div.orders-blk');
    for await (const table of orderTable) {
      let foundTracking: boolean;
      try {
        foundTracking = !!(await table.$('div.tr-id'));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        foundTracking = false;
      }
      if (!foundTracking) {
        // const orderIdLink = await table.$('a*=Order id:');
        const orderIdLink = await pup.getLink({ parent: table, locator: 'a', text: 'Order id:' });
        const orderId = orderIdLink.text;

        const shippingContainer = await pup.el({ locator: 'h2', text: 'Shipping Address' });

        const order: SystemOrder = {
          id: orderId.substring(orderId.indexOf('#') + 1),
          customer: {
            name: await pup.getText({ locator: 'p', parent: shippingContainer }), //await shippingContainer.$('p').getText(),
            email: (await pup.getText({ locator: 'p', text: 'Email', parent: table })).split(':')[1].trim(), // (await table.$('p*=Email').getText()).split(':')[1].trim(),
            username: (await pup.getText({ locator: 'p', text: 'Buyer', parent: table })).split(':')[1].trim(), //(await table.$('p*=Buyer').getText()).split(':')[1].trim(),
          },
          packingSlip: orderIdLink.href,
          lineItems: [],
        };

        const itemLines = await (await table.$('div.col-md-4')).$$('p');
        for (const itemLine of itemLines) {
          const line = await pup.getText(itemLine);
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

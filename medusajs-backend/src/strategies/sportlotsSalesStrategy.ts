import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login as slLogin } from '../utils/sportlots';
import { ProductVariant } from '@medusajs/medusa';

abstract class SportlotsSalesStrategy extends SaleStrategy<PuppeteerHelper> {
  static identifier = 'sportlots-sales-strategy';
  static batchType = 'sportlots-sales-sync';
  static listingSite = 'SportLots';

  async login() {
    return await this.loginPuppeteer('https://www.sportlots.com/', slLogin);
  }

  async getOrders(pup: PuppeteerHelper): Promise<SystemOrder[]> {
    const orders: SystemOrder[] = [];

    const process = async (orderType: string) => {
      await pup.goto(`inven/dealbin/dealacct.tpl?ordertype=${orderType}`);
      const orderTable = await pup.$$('form[action="/inven/dealbin/dealupd.tpl"]');
      console.log('orderTable', orderTable);
      for (const table of orderTable) {
        //its divs all the way down!
        let i = 0;
        const divs = await table.$$(`div`);
        console.log('divs', divs.length);
        console.log('divi', divs[i]);
        const link = await divs[i].$('a');
        console.log(link);
        const orderId = await pup.getText(link);
        const username = orderId.slice(0, orderId.indexOf('2024'));
        const order: SystemOrder = {
          id: orderId,
          customer: {
            name: await pup.getAttribute(link, 'title'),
            username: username,
            email: `${username}@sportlots.com`,
          },
          packingSlip: (await pup.getAttribute(link, 'href'))
            .replace("javascript:showFAQ('", '')
            .replace("',1400,500)", ''),
          lineItems: [],
        };
        i = 15; // skip a bunch of junk
        const totalDivs = divs.length;
        this.log(`Processing divs: ${totalDivs}`);
        while (i + 6 <= totalDivs) {
          i++; //first is a blank div
          const quantity = await pup.getText(divs[i++]);
          const title = await pup.getText(divs[i++]);
          const bin = await pup.getText(divs[i++]);
          i++; // condition
          const price = await pup.getText(divs[i++]);
          const cardNumber = title
            .split(' ')
            .find((word) => word.startsWith('#'))
            .replace('#', '');
          const sku = bin.indexOf('|') > 0 ? bin : `${bin}|${cardNumber}`;
          let variant: ProductVariant | undefined;
          try {
            variant = await this.productVariantService_.retrieveBySKU(sku, {
              relations: ['product', 'product.variants'],
            });
          } catch (e) {
            this.log(`Could not find product variant for SKU: ${sku}`);
          }
          if (!variant && bin) {
            const [categories] = await this.categoryService_.listAndCount({});
            const category = categories.find((c) => c?.metadata?.bin === bin);
            if (category) {
              const [products] = await this.productService.listAndCount(
                { category_id: [category.id] },
                { relations: ['variants'] },
              );
              const product = products.find((p) => p.metadata.cardNumber === cardNumber);
              if (product) {
                variant = product?.variants.find((v) => v.metadata.sportlots === title);
              } else {
                products.forEach((p) => {
                  const v = p?.variants.find((v) => v.metadata.sportlots === title);
                  if (v) {
                    variant = v;
                  }
                });
              }
            }
          }
          if (variant && variant.metadata?.sportlots) {
            variant = variant.product.variants.find((v) => v.metadata.sportlots === title);
          }
          order.lineItems.push({
            quantity: parseInt(quantity),
            title: variant?.title || title,
            sku: variant?.sku || sku,
            cardNumber:
              <string>variant?.metadata?.cardNumber || <string>variant?.product?.metadata.cardNumber || cardNumber,
            unit_price: parseInt(price.replace('.', '').replace('$', '').trim()),
          });
        }
        this.log(`Found order: ${JSON.stringify(order, null, 2)}`);
        orders.push(order);
      }
    };

    await process('1b');
    await process('1a');

    this.log('Found Orders:');
    this.log(JSON.stringify(orders, null, 2));
    return orders;
  }
}

export default SportlotsSalesStrategy;

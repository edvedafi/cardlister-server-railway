import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import process from 'node:process';
import { ProductVariant } from '@medusajs/medusa';

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
            quantity: parseInt(quantity.replace('\n0', '').trim()),
            title: variant?.title || title,
            sku: variant?.sku,
            cardNumber: variant ? <string>variant.metadata.cardNumber : cardNumber,
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

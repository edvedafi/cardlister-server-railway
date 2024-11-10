import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { login as slLogin } from '../utils/sportlots';
import { Product, ProductVariant } from '@medusajs/medusa';
import { CategoryMap } from '../models/category-map';

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

      const rawOrders: SystemOrder[] = await pup.page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('form[action="/inven/dealbin/dealupd.tpl"]'));
        return tables.map((table) => {
          const divs = table.querySelectorAll('div');
          let i = 0;
          const link = divs[i].querySelector('a');
          const orderId = link?.textContent?.trim();
          const username = orderId.slice(0, orderId.indexOf('2024'));

          const order = {
            id: orderId,
            customer: {
              name: link.getAttribute('title'),
              username: username,
              email: `${username}@sportlots.com`,
            },
            packingSlip: link.getAttribute('href')?.replace("javascript:showFAQ('", '').replace("',1400,500)", ''),
            lineItems: [],
          };

          //skip the junk
          i = 15;

          while (i + 6 <= divs.length) {
            i++; //first is a blank div
            const quantity = parseInt(divs[i++].textContent.replace('\n', '').trim());
            const title = divs[i++].textContent.replace('\n', '').trim();
            const bin = divs[i++].textContent.replace('\n', '').trim();
            i++; // condition
            const price = divs[i++].textContent.replace('\n', '').trim();
            const cardNumber =
              title
                .split(' ')
                .find((word) => word.startsWith('#'))
                ?.replace('#', '') || 'NNO';
            const sku = bin.indexOf('|') > 0 ? bin : `${bin}|${cardNumber}`;
            order.lineItems.push({
              quantity: quantity,
              title: title,
              sku: sku,
              bin: bin,
              cardNumber: cardNumber,
              unit_price: parseInt(price?.replace('.', '').replace('$', '').trim() || '0') / quantity,
            });
          }
          return order;
        });
      });

      // this.log(`Found ${rawOrders.length} ${orderType} orders`);
      // this.log(JSON.stringify(rawOrders, null, 2));
      // rawOrders = [];
      const categories: CategoryMap = await this.binService.getAllBins();
      for (let orderNumber = 0; orderNumber < rawOrders.length; orderNumber++) {
        const rawOrder = rawOrders[orderNumber];
        const order: SystemOrder = {
          ...rawOrder,
          lineItems: [],
        };
        const rawLineItems = [...rawOrder.lineItems];

        for (let i = 0; i < rawLineItems.length; i++) {
          const lineItem = rawLineItems[i];
          // this.log(`Processing line item: ${lineItem.sku}`);
          let variant: ProductVariant | undefined;
          try {
            variant = await this.productVariantService_.retrieveBySKU(lineItem.sku, {
              relations: ['product', 'product.variants'],
            });
          } catch (e) {
            this.log(`Could not find product variant for SKU: ${lineItem.sku} (${e.message})`);
          }
          if (!variant && lineItem.bin) {
            const categoryId = categories[lineItem.bin];
            if (categoryId) {
              const products = await this.getProducts(categoryId);
              const product = products.find((p) => p.metadata.cardNumber === lineItem.cardNumber);
              if (product) {
                variant = product?.variants.find((v) => v.metadata.sportlots === lineItem.title);
              } else {
                products.forEach((p) => {
                  const v = p?.variants.find((v) => v.metadata.sportlots === lineItem.title);
                  if (v) {
                    variant = v;
                  }
                });
              }
            }
          }
          if (variant && variant.metadata?.sportlots) {
            variant = variant.product.variants.find((v) => v.metadata.sportlots === lineItem.title);
          }
          order.lineItems.push({
            quantity: lineItem.quantity,
            title: variant?.title || lineItem.title,
            sku: variant?.sku || lineItem.sku,
            cardNumber:
              <string>variant?.metadata?.cardNumber ||
              <string>variant?.product?.metadata.cardNumber ||
              lineItem.cardNumber,
            unit_price: lineItem.unit_price,
          });
          // this.log(`Found line item: ${order.lineItems.length}`);
        }
        orders.push(order);
      }
    };
    await process('1b');
    await process('1a');

    // this.log('Found Orders:');
    // this.log(JSON.stringify(orders, null, 2));
    return orders;
  }

  private productsByCategory: { [key: string]: Product[] } = {};

  async getProducts(categoryId: string): Promise<Product[]> {
    if (!this.productsByCategory[categoryId]) {
      const [products] = await this.productService.listAndCount(
        { category_id: [categoryId] },
        { relations: ['variants'] },
      );
      this.productsByCategory[categoryId] = products;
    }
    return this.productsByCategory[categoryId];
  }
}

export default SportlotsSalesStrategy;

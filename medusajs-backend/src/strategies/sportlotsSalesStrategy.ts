import { AxiosInstance } from 'axios';
import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { fetchOrderHeaders, fetchPullRows, login as slLogin } from '../utils/sportlots-api';
import { groupPullRows, joinOrders, SlStream } from '../utils/sportlots-parse';
import { Product, ProductVariant } from '@medusajs/medusa';
import { CategoryMap } from '../models/category-map';

const STREAMS: SlStream[] = ['box', 'paid'];

abstract class SportlotsSalesStrategy extends SaleStrategy<AxiosInstance> {
  static identifier = 'sportlots-sales-strategy';
  static batchType = 'sportlots-sales-sync';
  static listingSite = 'SportLots';

  async login(): Promise<AxiosInstance> {
    return await slLogin(this.loginAxios.bind(this));
  }

  async getOrders(api: AxiosInstance): Promise<SystemOrder[]> {
    const raw: SystemOrder[] = [];

    // 'box' ships to the SportLots box, 'paid' ships direct to the buyer. We treat them
    // identically, but each stream must be joined against its own pull sheet before merging.
    for (const stream of STREAMS) {
      const [headers, rows] = await Promise.all([
        fetchOrderHeaders(api, stream, (message) => this.log(`${stream}: ${message}`)),
        fetchPullRows(api, stream),
      ]);
      this.log(`Found ${headers.length} ${stream} orders covering ${rows.length} cards`);
      raw.push(...joinOrders(headers, groupPullRows(rows), (message) => this.log(`${stream}: ${message}`)));
    }

    // Order ids become the draft order idempotency_key, so a duplicate across streams would collide.
    const deduped = [...new Map(raw.map((order) => [order.id, order])).values()];

    return await this.resolveLineItems(deduped);
  }

  /**
   * Resolves each scraped line item to a real product variant. SportLots gives us a bin and a card
   * number; the SKU lookup usually hits, and the bin -> category -> product walk covers legacy bins
   * whose SKUs were never normalized.
   */
  private async resolveLineItems(rawOrders: SystemOrder[]): Promise<SystemOrder[]> {
    const orders: SystemOrder[] = [];
    const categories: CategoryMap = await this.binService.getAllBins();

    for (const rawOrder of rawOrders) {
      const order: SystemOrder = { ...rawOrder, lineItems: [] };

      for (const lineItem of rawOrder.lineItems) {
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
      }

      orders.push(order);
    }

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

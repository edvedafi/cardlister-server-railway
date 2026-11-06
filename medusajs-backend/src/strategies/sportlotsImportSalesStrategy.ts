import { AxiosInstance } from 'axios';
import { SystemOrder } from './AbstractSalesStrategy';
import SportlotsSalesStrategy from './sportlotsSalesStrategy';

export const SPORTLOTS_IMPORT_BATCH_TYPE = 'sportlots-import-sales';

/**
 * Creates SportLots orders from pull reports saved by hand (POST /admin/sales/import) instead of
 * fetching them from the site. Jobs are created as dry runs: pre-processing stores a preview in the
 * job result, and confirming the job creates the orders through the normal sales flow.
 */
class SportlotsImportSalesStrategy extends SportlotsSalesStrategy {
  static identifier = 'sportlots-import-sales-strategy';
  static batchType = SPORTLOTS_IMPORT_BATCH_TYPE;
  static listingSite = 'SportLots';

  // processJob needs a connection to hold, but nothing here contacts SportLots.
  async login(): Promise<AxiosInstance> {
    return this.loginAxios('https://www.sportlots.com/', {});
  }

  private async importedOrders(batchJobId: string): Promise<SystemOrder[]> {
    const batchJob = await this.batchJobService_.retrieve(batchJobId);
    return await this.resolveLineItems(batchJob.context.orders as SystemOrder[]);
  }

  async getOrders(_api: AxiosInstance, batchJobId: string): Promise<SystemOrder[]> {
    return await this.importedOrders(batchJobId);
  }

  async preProcessBatchJob(batchJobId: string): Promise<void> {
    const orders = await this.importedOrders(batchJobId);

    const preview = [];
    for (const order of orders) {
      const [draft] = await this.draftOrderService.list({ idempotency_key: order.id });
      const items = [];
      for (const lineItem of order.lineItems) {
        // The same lookup processJob uses: a miss here becomes a line item with no card behind it.
        const matched = await this.productVariantService_.retrieveBySKU(lineItem.sku).then(
          () => true,
          () => false,
        );
        items.push({ ...lineItem, matched });
      }
      preview.push({ id: order.id, username: order.customer.username, alreadyImported: !!draft, items });
    }

    await this.atomicPhase_(async (transactionManager) => {
      await this.batchJobService_.withTransaction(transactionManager).update(batchJobId, {
        result: {
          advancement_count: 0,
          count: preview.length,
          preview,
          stat_descriptors: [],
        },
      });
    });
  }
}

export default SportlotsImportSalesStrategy;

import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { IInventoryService } from '@medusajs/types';
import { InventoryService } from '@medusajs/inventory/dist/services';
import { AxiosInstance } from 'axios';
import eBayApi from 'ebay-api';
import AbstractSiteStrategy from './AbstractSiteStrategy';
import { PuppeteerHelper } from '../utils/puppeteer-helper';

type InjectedDependencies = {
  transactionManager: EntityManager;
  inventoryService: InventoryService;
};

export type ListAttempt =
  | { skipped: boolean; quantity?: never; error?: never; platformMetadata?: Record<string, string> }
  | { skipped?: never; quantity: number; error?: never; platformMetadata?: Record<string, string> }
  | { skipped?: never; quantity?: never; error: string; platformMetadata?: Record<string, string> };

export type SyncResult = { success: number; error?: string[] };

abstract class AbstractListingStrategy<
  T extends AxiosInstance | eBayApi | PuppeteerHelper,
> extends AbstractSiteStrategy<T> {
  static identifier = 'listing-strategy';
  static batchType = 'listing-sync';
  static listingSite = 'sync-site';
  private inventoryModule: IInventoryService;
  protected requireImages = false;
  protected minPrice = 0.01;

  protected constructor(__container__: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    try {
      this.inventoryModule = __container__.inventoryService;
    } catch (e) {
      this.log(`${(<typeof AbstractListingStrategy>this.constructor).identifier}::constructor::error`, e);
    }
  }

  async preProcessBatchJob(batchJobId: string): Promise<void> {
    try {
      return await this.atomicPhase_(async (transactionManager) => {
        const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);

        const category = await this.categoryService_
          .withTransaction(transactionManager)
          .retrieve(batchJob.context.category_id as string, { relations: ['products'] });
        const count = category.products.length;

        await this.batchJobService_.withTransaction(transactionManager).update(batchJob, {
          result: {
            advancement_count: 0,
            count,
            stat_descriptors: [
              {
                key: `${(<typeof AbstractListingStrategy>this.constructor).identifier}-update-count`,
                name: `Number of products to publish to ${(<typeof AbstractListingStrategy>this.constructor).listingSite}`,
                message: `${count} products will be published.`,
              },
            ],
          },
        });
      });
    } catch (e) {
      this.log('preProcessBatchJob::error', e);
      throw e;
    }
  }

  async processJob(batchJobId: string): Promise<void> {
    return await this.atomicPhase_(async (transactionManager) => {
      let categoryId: string;
      try {
        // return await this.atomicPhase_(async (transactionManager) => {
        // const batchJob = await this.batchJobService_.retrieve(batchJobId);
        await this.atomicPhase_(async (transactionManager) => {
          const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);
          categoryId = <string>batchJob.context.category_id;
          this.log(`process: ${batchJobId} is set to ${batchJob.status}`);
          if (batchJob.status === 'confirmed') {
            this.log('Setting Processing');
            await this.batchJobService_.withTransaction(transactionManager).setProcessing(batchJobId);
            this.log('Moving on');
          } else if (['completed', 'failed'].includes(batchJob.status)) {
            this.log(`Skipping processing ${batchJobId} as it is already ${batchJob.status}`);
            return;
          }
        });

        //TODO This needs to be user specific
        await this.getLocationId();
        await this.getRegionId();

        let category: ProductCategory;
        let productList: Product[];
        try {
          category = await this.categoryService_.retrieve(categoryId, {
            relations: ['products', 'products.variants', 'products.variants.prices', 'products.images'],
          });
          productList = category.products;
        } catch (e) {
          this.log(
            `${(<typeof AbstractListingStrategy>this.constructor).batchType}::prep category::error ${e.message}`,
            e,
          );
          throw e;
        }
        let connection: T;
        let result: SyncResult;
        try {
          this.progress('Login');
          connection = await this.login();

          this.progress('Clearing inventory');
          await this.removeAllInventory(connection, category);

          this.progress('Adding New inventory');
          result = await this.syncProducts(connection, productList, category, this.advanceCount.bind(this, batchJobId));

          this.finishProgress(`${result.success} cards added; ${result.error} errors`);
        } catch (e) {
          this.progress(e.message, e);
          throw e;
        } finally {
          await this.logout(connection);
        }

        await this.batchJobService_.withTransaction(transactionManager).update(batchJobId, {
          result: {
            advancement_count: result.success,
            errors: result.error?.map((e) => ({
              message: 'Error syncing products',
              code: 'ERR',
              err: e,
            })),
          },
        });
      } catch (e) {
        this.log(`:processJob::error ${e.message}`, e);
        throw e;
      }
    });
  }

  async removeAllInventory(connection: T, category: ProductCategory): Promise<void> {
    this.log(
      `Implement removeAllInventory to do a full sync of all products from ${category.id} on ${typeof connection} `,
    );
  }

  async syncProducts(
    browser: T,
    products: Product[],
    category: ProductCategory,
    advanceCount: (count: number) => Promise<number>,
  ): Promise<SyncResult> {
    const updated: { success: number; error?: string[] } = { success: 0 };
    let count = 0;
    for (const product of products) {
      if (!this.requireImages || product.images.length > 0) {
        for (const variant of product.variants) {
          try {
            const price = this.getPrice(variant);
            if (!price || price < this.minPrice) {
              this.log(`Skipping ${variant.sku} because price is below minimum`);
            } else {
              const quantity = await this.getQuantity({ variant });
              let result: ListAttempt;
              let updateType = 'Added ';
              if (quantity < 1) {
                result = await this.removeProduct(browser, product, variant, category);
                updateType = 'Removed ';
              } else {
                result = await this.syncProduct(browser, product, variant, category, quantity, price);
              }
              if (result.skipped) {
                this.log(`Skipped ${variant.sku}`);
              } else if (result.error) {
                throw new Error(result.error);
              } else {
                if (result.platformMetadata) {
                  await this.productVariantService_.update(variant, {
                    metadata: {
                      ...variant.metadata,
                      ...result.platformMetadata,
                    },
                  });
                }
                this.log(`Sync Complete on ${variant.sku}: ${updateType} ${result.quantity} items`);
                updated.success += result.quantity;
              }
              count = await advanceCount(count);
            }
          } catch (e) {
            //TODO Need to log in a way that is actionable
            this.log(`Error syncing ${variant.sku}`, e);
            if (!updated.error) updated.error = [];
            updated.error.push(e.message?.indexOf(variant.sku) > -1 ? e.message : `${variant.sku}: ${e.message}`);
          }
        }
      } else {
        this.log(`Skipping ${product.title} because it has no images`);
      }
    }
    return updated;
  }

  async syncProduct(
    connection: T,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
    quantity: number,
    price: number,
  ): Promise<ListAttempt> {
    return {
      error: `Implement syncProduct to sync a single product for Connection: ${typeof connection} product: ${product.id} | productVariant: ${productVariant.id} | category: ${category.id} => ${quantity} @ ${price}`,
    };
  }

  async removeProduct(
    connection: T,
    product: Product,
    productVariant: ProductVariant,
    category: ProductCategory,
  ): Promise<ListAttempt> {
    return {
      error: `Implement remove to remove from Connection: ${typeof connection} => product: ${product.id} | productVariant: ${productVariant.id} | category: ${category.id}`,
    };
  }

  protected async getQuantity(search: QuantityOptions): Promise<number> {
    const sku = search.sku ? search.sku : search.variant.sku;
    const [inventoryItems, count] = await this.inventoryModule.listInventoryItems({ sku });
    // this.log(`Found ${count} inventory items for [${sku}]`);
    if (count > 0) {
      const quantityFromService = await this.inventoryModule.retrieveAvailableQuantity(inventoryItems[0].id, [
        this.location,
      ]);
      const result = isNaN(quantityFromService) ? 0 : quantityFromService;
      this.log(`Quantity for ${sku} is ${result} at location ${this.location}.`);
      return result;
    } else {
      this.log(`No inventory items found for [${sku}]: ${JSON.stringify(inventoryItems)}`);
      return 0;
    }
  }

  protected getPrice(variant: ProductVariant): number {
    return super.getPrice(variant) / 100;
  }
}

export type QuantityOptions = { sku: string; variant?: never } | { sku?: never; variant: ProductVariant };

export default AbstractListingStrategy;

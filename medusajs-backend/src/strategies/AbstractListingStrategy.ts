import { Product, ProductCategory, ProductVariant } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { IInventoryService } from '@medusajs/types';
import { InventoryService } from '@medusajs/inventory/dist/services';
import { AxiosInstance } from 'axios';
import eBayApi from 'ebay-api';
import AbstractSiteStrategy from './AbstractSiteStrategy';

type InjectedDependencies = {
  transactionManager: EntityManager;
  inventoryService: InventoryService;
};

abstract class AbstractListingStrategy<
  T extends WebdriverIO.Browser | AxiosInstance | eBayApi,
> extends AbstractSiteStrategy<T> {
  static identifier = 'listing-strategy';
  static batchType = 'listing-sync';
  static listingSite = 'sync-site';
  private inventoryModule: IInventoryService;
  protected requireImages = false;

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

        try {
          this.progress('Login');
          connection = await this.login();

          this.progress('Clearing inventory');
          await this.removeAllInventory(connection, category);

          this.progress('Adding New inventory');
          const added = await this.syncProducts(
            connection,
            productList,
            category,
            this.advanceCount.bind(this, batchJobId),
          );

          this.finishProgress(`${added} cards added`);
        } catch (e) {
          this.progress(e.message, e);
          throw e;
        } finally {
          await this.logout(connection);
        }

        await this.batchJobService_.withTransaction(transactionManager).update(batchJobId, {
          result: {
            advancement_count: productList.length,
          },
        });
        // await this.batchJobService_.complete(batchJobId);
        // });
      } catch (e) {
        this.log(`:processJob::error ${e.message}`, e);
        // await this.batchJobService_.setFailed(batchJobId, e.message);
        throw e;
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(browser: T, category: ProductCategory): Promise<void> {
    this.log('Implement removeAllInventory to do a full sync of all products');
  }

  async syncProducts(
    browser: T,
    products: Product[],
    category: ProductCategory,
    advanceCount: (count: number) => Promise<number>,
  ): Promise<number> {
    let updated = 0;
    let count = 0;
    for (const product of products) {
      if (!this.requireImages || product.images.length > 0) {
        for (const variant of product.variants) {
          try {
            updated += await this.syncProduct(
              browser,
              product,
              variant,
              category,
              await this.getQuantity({ variant }),
              this.getPrice(variant),
            );
            count = await advanceCount(count);
          } catch (e) {
            //TODO Need to log in a way that is actionable
            this.log(`Error syncing ${variant.sku}`, e);
          }
        }
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
  ): Promise<number> {
    this.log(
      `Implement syncProduct to sync a single product for Connection: ${typeof connection} product: ${product.id} | productVariant: ${productVariant.id} | category: ${category.id} => ${quantity} @ ${price}`,
    );
    return 0;
  }

  protected async getQuantity(search: QuantityOptions): Promise<number> {
    const sku = search.sku ? search.sku : search.variant.sku;
    const [inventoryItems] = await this.inventoryModule.listInventoryItems({ sku });
    const quantityFromService = await this.inventoryModule.retrieveAvailableQuantity(inventoryItems[0].id, [
      this.location,
    ]);
    this.log(
      `Quantity for ${sku} is ${quantityFromService} at location ${this.location}. Inventory Items had ${inventoryItems.length} records: ${JSON.stringify(inventoryItems)}`,
    );
    return isNaN(quantityFromService) ? 0 : quantityFromService;
  }
}

export type QuantityOptions = { sku: string; variant?: never } | { sku?: never; variant: ProductVariant };

export default AbstractListingStrategy;

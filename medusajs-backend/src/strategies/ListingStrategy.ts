import {
  AbstractBatchJobStrategy,
  BatchJobService,
  CreateBatchJobInput,
  Logger,
  Product,
  ProductCategory,
  ProductCategoryService,
  ProductVariant,
  ProductVariantService,
  RegionService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { remote } from 'webdriverio';
import { IInventoryService } from '@medusajs/types';
import { InventoryService } from '@medusajs/inventory/dist/services';
import { getBrowserlessConfig } from '../utils/browserless';
import { StockLocationService } from '@medusajs/stock-location/dist/services';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import eBayApi from 'ebay-api';

type InjectedDependencies = {
  batchJobService: BatchJobService;
  productCategoryService: ProductCategoryService;
  manager: EntityManager;
  transactionManager: EntityManager;
  productVariantService: ProductVariantService;
  inventoryService: InventoryService;
  logger: Logger;
  stockLocationService: StockLocationService;
  regionService: RegionService;
};

abstract class ListingStrategy<
  T extends WebdriverIO.Browser | AxiosInstance | eBayApi,
> extends AbstractBatchJobStrategy {
  static identifier = 'listing-strategy';
  static batchType = 'listing-sync';
  static listingSite = 'sync-site';
  protected batchJobService_: BatchJobService;
  protected categoryService_: ProductCategoryService;
  protected productVariantService_: ProductVariantService;
  private inventoryModule: IInventoryService;
  private stockLocationService: StockLocationService;
  private regionService: RegionService;
  private readonly logger: Logger;
  private location: string;
  private region: string;
  protected requireImages = false;

  protected constructor(__container__: InjectedDependencies) {
    let log: Logger | undefined;
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    try {
      log = __container__.logger;
      this.logger = log;
      this.batchJobService_ = __container__.batchJobService || this.batchJobService_;
      this.categoryService_ = __container__.productCategoryService;
      this.productVariantService_ = __container__.productVariantService;
      this.inventoryModule = __container__.inventoryService;
      this.stockLocationService = __container__.stockLocationService;
      this.regionService = __container__.regionService;
    } catch (e) {
      this.log(`${(<typeof ListingStrategy>this.constructor).identifier}::constructor::error`, e);
    }
  }

  protected log(message: string, error?: Error) {
    const logger = this.logger || console;
    if (error) {
      logger.error(`${(<typeof ListingStrategy>this.constructor).identifier}::${message}`, error);
    } else {
      logger.info(`${(<typeof ListingStrategy>this.constructor).identifier}::${message}`);
    }
  }

  async buildTemplate(): Promise<string> {
    return '';
  }

  async prepareBatchJobForProcessing(batchJob: CreateBatchJobInput): Promise<CreateBatchJobInput> {
    // make changes to the batch job's fields...
    return batchJob;
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
                key: `${(<typeof ListingStrategy>this.constructor).identifier}-update-count`,
                name: `Number of products to publish to ${(<typeof ListingStrategy>this.constructor).listingSite}`,
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
    //TODO This needs to be user specific
    const locations = await this.stockLocationService.list({ name: 'Edvedafi Card Shop' });
    if (locations.length === 0) throw 'No StockLocation Found';
    if (locations.length > 1) throw `Multiple StockLocations Found ${JSON.stringify(locations, null, 2)}`;
    this.location = locations[0]?.id;
    if (!this.location) throw `No StockLocation Found. ${JSON.stringify(locations)}`;

    const region = await this.regionService.list({ name: (<typeof ListingStrategy>this.constructor).listingSite });
    this.region = region[0]?.id;
    if (!this.region) throw `No Region Found for ${(<typeof ListingStrategy>this.constructor).listingSite}`;

    try {
      return await this.atomicPhase_(async (transactionManager) => {
        let category: ProductCategory;
        let productList: Product[];
        try {
          const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);

          category = await this.categoryService_.retrieve(batchJob.context.category_id as string, {
            relations: ['products', 'products.variants', 'products.variants.prices', 'products.images'],
          });
          productList = category.products;
        } catch (e) {
          this.logger.error(
            `${(<typeof ListingStrategy>this.constructor).batchType}::prep category::error ${e.message}`,
            e,
          );
          throw e;
        }
        let connection: T;
        let activityId: string;

        try {
          // @ts-expect-error Not sure why activity is typed as running void, the documentation says it returns this id
          activityId = this.logger.activity(`${(<typeof ListingStrategy>this.constructor).batchType}::Login`);
          connection = await this.login();

          this.logger.progress(
            activityId,
            `${(<typeof ListingStrategy>this.constructor).batchType}::Clearing inventory`,
          );
          await this.removeAllInventory(connection, category);

          this.logger.progress(
            activityId,
            `${(<typeof ListingStrategy>this.constructor).batchType}::Adding New inventory`,
          );
          const added = await this.syncProducts(connection, productList, category);

          this.logger.success(
            activityId,
            `${(<typeof ListingStrategy>this.constructor).batchType}::sync::complete! ${added} cards added`,
          );
        } catch (e) {
          this.logger.failure(
            activityId,
            `${(<typeof ListingStrategy>this.constructor).batchType}::sync::error ${e.message}`,
          );
          throw e;
        } finally {
          await this.logout(connection);
        }

        await this.batchJobService_.withTransaction(transactionManager).update(batchJobId, {
          result: {
            advancement_count: productList.length,
          },
        });
      });
    } catch (e) {
      this.logger.error(`${(<typeof ListingStrategy>this.constructor).batchType}::processJob::error ${e.message}`, e);
      throw e;
    }
  }

  abstract login(): Promise<T>;

  protected async loginWebDriver(baseURL: string): Promise<WebdriverIO.Browser> {
    return remote(
      getBrowserlessConfig(
        baseURL,
        `${(<typeof ListingStrategy>this.constructor).listingSite.toUpperCase()}_LOG_LEVEL`.toLowerCase(),
      ),
    );
  }

  protected loginAxios(baseURL: string, headers: { [key: string]: string }): AxiosInstance {
    const api = axios.create({
      baseURL: baseURL,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        origin: baseURL,
        referer: baseURL,
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': 'macOS',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        ...headers,
      },
    });

    axiosRetry(api, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
    return api;
  }

  protected async logout(connection: T): Promise<void> {
    // @ts-expect-error - deleteSession is not defined on AxiosInstance and can't figure out how to type it
    if (connection && connection.deleteSession) {
      // @ts-expect-error - deleteSession is not defined on AxiosInstance and can't figure out how to type it
      await connection.deleteSession();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllInventory(browser: T, category: ProductCategory): Promise<void> {
    this.log('Implement removeAllInventory to do a full sync of all products');
  }

  async syncProducts(browser: T, products: Product[], category: ProductCategory): Promise<number> {
    let updated = 0;
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

  protected getPrice(variant: ProductVariant): number {
    let price = variant.prices?.find((p) => p.region_id === this.region)?.amount;
    if (!price) {
      this.log(`Price not found for variant ${variant.id} in region ${this.region}`); //TODO Need to handle this in a recoverable way
      price = variant.prices?.find((p) => !p.region_id)?.amount;
    }

    if (!price) throw new Error(`Unable to find price of variant ${JSON.stringify(variant, null, 2)}`);

    return price / 100;
  }
}

export type QuantityOptions = { sku: string; variant?: never } | { sku?: never; variant: ProductVariant };

export default ListingStrategy;

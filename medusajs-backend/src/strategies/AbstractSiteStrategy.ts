import {
  AbstractBatchJobStrategy,
  BatchJobService,
  CreateBatchJobInput,
  Logger,
  ProductCategoryService,
  ProductVariant,
  ProductVariantService,
  RegionService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { remote } from 'webdriverio';
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
  regionService: RegionService;
  stockLocationService: StockLocationService;
};

abstract class AbstractSiteStrategy<
  T extends WebdriverIO.Browser | AxiosInstance | eBayApi,
> extends AbstractBatchJobStrategy {
  static identifier = 'listing-strategy';
  static batchType = 'listing-sync';
  static listingSite = 'sync-site';
  protected batchJobService_: BatchJobService;
  protected categoryService_: ProductCategoryService;
  protected productVariantService_: ProductVariantService;
  protected regionService: RegionService;
  protected stockLocationService: StockLocationService;
  private readonly logger: Logger;
  protected region: string;
  protected location: string;

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
      this.regionService = __container__.regionService;
      this.stockLocationService = __container__.stockLocationService;
    } catch (e) {
      this.log(`${(<typeof AbstractSiteStrategy>this.constructor).identifier}::constructor::error`, e);
    }
  }

  protected log(message: string, error?: Error) {
    const logger = this.logger || console;
    if (error) {
      console.error(
        `${(<typeof AbstractSiteStrategy>this.constructor).identifier}::${message}::${error.message}`,
        error,
      );
      logger.error(
        `${(<typeof AbstractSiteStrategy>this.constructor).identifier}::${message}::${error.message}`,
        error,
      );
    } else {
      logger.info(`${(<typeof AbstractSiteStrategy>this.constructor).identifier}::${message}`);
    }
  }

  private activityId: string | undefined | void;
  private baseMessage: string;

  protected progress(message: string, error?: Error) {
    if (this.baseMessage) {
      if (error) {
        this.logger.error(`${message}`, error);
        this.logger.failure(this.activityId, `${this.baseMessage}: Failed: ${message}`);
      } else {
        this.logger.progress(this.activityId, `${this.baseMessage} (${message})`);
      }
    } else {
      this.baseMessage = `${(<typeof AbstractSiteStrategy>this.constructor).batchType}::${message}`;
      this.activityId = this.logger.activity(this.baseMessage);
    }
  }

  protected finishProgress(message: string) {
    this.logger.success(this.activityId, `${this.baseMessage} completed! ${message}`);
  }

  async buildTemplate(): Promise<string> {
    return '';
  }

  async prepareBatchJobForProcessing(batchJob: CreateBatchJobInput): Promise<CreateBatchJobInput> {
    // make changes to the batch job's fields...
    return batchJob;
  }

  abstract login(): Promise<T>;

  protected async loginWebDriver(baseURL: string): Promise<WebdriverIO.Browser> {
    return remote(
      getBrowserlessConfig(
        baseURL,
        `${(<typeof AbstractSiteStrategy>this.constructor).listingSite.toUpperCase()}_LOG_LEVEL`.toLowerCase(),
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

  protected async advanceCount(batchId: string, count: number): Promise<number> {
    const newCount = count + 1;
    this.log(`Advancing count to ${newCount}`);
    await this.atomicPhase_(async (transactionManager) => {
      await this.batchJobService_.withTransaction(transactionManager).update(batchId, {
        result: {
          advancement_count: newCount,
        },
      });
      const job = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchId);
      if (job.status === 'canceled') {
        throw new Error(`Job ${batchId} was canceled`);
      }
    });
    this.log('Advancing count complete');
    return newCount;
  }

  protected async getRegionId(): Promise<string> {
    if (!this.region) {
      const region = await this.regionService.list({
        name: (<typeof AbstractSiteStrategy>this.constructor).listingSite,
      });
      this.region = region[0]?.id;
      if (!this.region) throw `No Region Found for ${(<typeof AbstractSiteStrategy>this.constructor).listingSite}`;
      return this.region;
    }
    return this.region;
  }

  protected async getLocationId(): Promise<string> {
    if (!this.location) {
      const locations = await this.stockLocationService.list({ name: 'Edvedafi Card Shop' });
      if (locations.length === 0) throw 'No StockLocation Found';
      if (locations.length > 1) throw `Multiple StockLocations Found ${JSON.stringify(locations, null, 2)}`;
      this.location = locations[0]?.id;
      if (!this.location) throw `No StockLocation Found. ${JSON.stringify(locations)}`;
    }
    return this.location;
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

export default AbstractSiteStrategy;

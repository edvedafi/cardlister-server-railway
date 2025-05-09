import {
  AbstractBatchJobStrategy,
  BatchJobService,
  CreateBatchJobInput,
  Logger,
  ProductCategoryService,
  ProductService,
  ProductVariant,
  ProductVariantService,
  RegionService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { InventoryService } from '@medusajs/inventory/dist/services';
import { StockLocationService } from '@medusajs/stock-location/dist/services';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import eBayApi from 'ebay-api';
import { PuppeteerHelper } from '../utils/puppeteer-helper';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

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
  T extends AxiosInstance | eBayApi | PuppeteerHelper,
> extends AbstractBatchJobStrategy {
  static identifier = 'listing-strategy';
  static batchType = 'listing-sync';
  static listingSite = 'sync-site';
  protected batchJobService_: BatchJobService;
  protected categoryService_: ProductCategoryService;
  protected productVariantService_: ProductVariantService;
  protected productService: ProductService;
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
        this.logger.error(`${message} - ${error.message}`, error);
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

  protected async loginPuppeteer(
    baseUrl: string,
    loginFunction?: (pup: PuppeteerHelper) => Promise<PuppeteerHelper>,
  ): Promise<PuppeteerHelper> {
    let puppeteerHelper: PuppeteerHelper;
    try {
      puppeteerHelper = new PuppeteerHelper();
      await puppeteerHelper.init(baseUrl);
      return loginFunction ? loginFunction(puppeteerHelper) : puppeteerHelper;
    } catch (e) {
      this.log('Error logging in with puppeteer', e);
      if (puppeteerHelper) {
        await this.logout(<T>puppeteerHelper);
      }
      throw e;
    }
  }

  protected loginAxios(
    baseURL: string,
    headers: {
      [key: string]: string;
    },
    useCookieJar = false,
  ): AxiosInstance {
    const options = {
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
    };
    let api: AxiosInstance;
    if (useCookieJar) {
      const jar = new CookieJar(); // Create a cookie jar
      api = wrapper(axios.create({ ...options, jar, withCredentials: true })); // W
    } else {
      api = axios.create(options);
    }

    axiosRetry(api, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
    return api;
  }

  protected async logout(connection: T): Promise<void> {
    try {
      if (connection && 'close' in connection) {
        connection.close();
      }
    } catch (e) {
      this.log('Error logging out (connection.close)', e);
    }

    try {
      if (connection && 'deleteSession' in connection && typeof connection.deleteSession === 'function') {
        await connection.deleteSession();
      }
    } catch (e) {
      this.log('Error logging out (connection.deleteSession)', e);
    }
  }

  protected async advanceCount(batchId: string, count: number): Promise<number> {
    const newCount = count + 1;
    // this.log(`Advancing count to ${newCount}`);
    await this.atomicPhase_(async (transactionManager) => {
      // await this.batchJobService_.withTransaction(transactionManager).update(batchId, {
      //   result: {
      //     advancement_count: newCount,
      //   },
      // });
      const job = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchId);
      if (job.status === 'canceled') {
        throw new Error(`Job ${batchId} was canceled`);
      }
    });
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
      this.log(`Price not found for variant ${variant.sku} in region ${this.region} of the ${variant.prices?.length}`); //TODO Need to handle this in a recoverable way
      variant.prices?.forEach((p) => this.log(`Price: ${p.region_id} - ${p.amount}`));
      price = variant.prices?.find((p) => !p.region_id)?.amount;
    }

    if (!price) {
      console.log(`Unable to find price of variant ${JSON.stringify(variant, null, 2)}`);
      price = 99;
    }

    return variant.prices?.find((p) => p.region_id === this.region)?.amount;
  }
}

export default AbstractSiteStrategy;

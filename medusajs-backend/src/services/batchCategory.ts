import { Logger, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import { SyncRequest } from '../models/sync-request';
import BinService from './bin';
import { CategoryMap } from '../models/category-map';

type InjectedDependencies = {
  // manager: EntityManager;
  productCategoryService: ProductCategoryService;
  binService: BinService;
  logger: Logger;
};

class BatchCategoryService extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;
  protected readonly binService: BinService;
  protected readonly logger: Logger;

  constructor({ productCategoryService, binService, logger }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
    this.binService = binService;
    this.logger = logger;
  }

  public async getCategories(request: SyncRequest): Promise<string[]> {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity(`Gathering Categories for ${JSON.stringify(request)}`);
    const update = (message: string) => this.logger.log(activityId, `BATCH-CAT-SERVICE - ${message}`);

    const categories: Set<string> = new Set<string>();

    const processCategory = async (categoryId: string) => {
      update(`Processing Category: ${categoryId}`);
      const category = await this.productCategoryService.retrieve(categoryId, { relations: ['category_children'] });
      update(`Fround Category: ${category.description} => ${category.category_children?.length}`);
      if (category.category_children && category.category_children.length > 0) {
        for (const child of category.category_children) {
          await processCategory(child.id);
        }
      } else {
        categories.add(categoryId);
      }
    };

    if (Array.isArray(request.category)) {
      for (const category of request.category) {
        await processCategory(category);
      }
    } else if (typeof request.category === 'string') {
      await processCategory(request.category);
    }

    const categoryMap: CategoryMap = await this.binService.getAllBins();

    const processBin = async (binId: string) => {
      update(`Processing Bin: ${binId}`);
      if (categoryMap[binId]) {
        await processCategory(categoryMap[binId]);
      } else {
        this.logger.error(JSON.stringify(categoryMap, null, 2));
        this.logger.error(`SYNC - Bin Not Found: ${binId}`);
      }
    };

    if (Array.isArray(request.bin)) {
      for (const bin of request.bin) {
        await processBin(bin);
      }
    } else if (typeof request.bin === 'string') {
      await processBin(request.bin);
    }

    if (Array.isArray(request.sku)) {
      for (const sku of request.sku) {
        await processBin(sku.replace('[', '').replace(']', '').split('|')[0].trim());
      }
    } else if (typeof request.bin === 'string') {
      await processBin(request.sku.replace('[', '').replace(']', '').split('|')[0].trim());
    }

    this.logger.success(activityId, `Found ${categories.size} categories`);
    return Array.from(categories);
  }
}

export default BatchCategoryService;

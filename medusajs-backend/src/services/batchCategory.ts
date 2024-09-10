import { Logger, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import { SyncRequest } from '../models/sync-request';

type InjectedDependencies = {
  // manager: EntityManager;
  productCategoryService: ProductCategoryService;
  logger: Logger;
};

class BatchCategory extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;
  protected readonly logger: Logger;

  constructor({ productCategoryService, logger }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
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

    //TODO Currently brute force is ok, need to move this to the service so it can be queried instead
    const [allCategories] = await this.productCategoryService.listAndCount({});
    type CategoryMap = { [key: string]: string };
    const categoryMap: CategoryMap = allCategories.reduce<CategoryMap>((acc: CategoryMap, c): CategoryMap => {
      if (c.metadata.bin) {
        acc[c.metadata.bin.toString()] = c.id;
      }
      return acc;
    }, {});

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

export default BatchCategory;

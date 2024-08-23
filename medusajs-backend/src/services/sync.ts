import { BatchJob, BatchJobService, Logger, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { SyncRequest } from '../models/sync-request';

type InjectedDependencies = {
  manager: EntityManager;
  batchJobService: BatchJobService;
  productCategoryService: ProductCategoryService;
  logger: Logger;
};

class SyncService extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;
  protected readonly batchJobService: BatchJobService;
  protected readonly logger: Logger;

  constructor({ batchJobService, productCategoryService, logger }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
    this.batchJobService = batchJobService;
    this.logger = logger;
  }

  public async sync(request: SyncRequest): Promise<BatchJob[]> {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity(`Running Sync on ${JSON.stringify(request)}`);
    const update = (message: string) => this.logger.progress(activityId, `SYNC - ${message}`);

    const categories: Set<string> = new Set<string>();
    const responses: BatchJob[] = [];

    const processCategory = async (categoryId: string) => {
      update(`Processing Category: ${categoryId}`);
      const category = await this.productCategoryService.retrieve(categoryId);
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

    for (const category of categories) {
      if (!request.only || request.only.includes('sportlots')) {
        update('Starting Sportlots Sync');
        responses.push(
          await this.batchJobService.create({
            type: 'sportlots-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      }

      if (!request.only || request.only.includes('bsc')) {
        update('Starting BSC Sync');
        responses.push(
          await this.batchJobService.create({
            type: 'bsc-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      }

      if (!request.only || request.only.includes('ebay')) {
        update('Starting Ebay Sync');
        responses.push(
          await this.batchJobService.create({
            type: 'ebay-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      }

      if (!request.only || request.only.includes('mcp')) {
        update('Starting MCP Sync');
        responses.push(
          await this.batchJobService.create({
            type: 'mcp-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      }

      if (request.only && request.only.includes('test')) {
        update('Starting TEST Sync');
        responses.push(
          await this.batchJobService.create({
            type: 'test-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      }
    }
    const displayableCategories = Array.from(categories);
    this.logger.success(activityId, `Sync Started for ${JSON.stringify(displayableCategories)} categories`);
    return responses;
  }
}

export default SyncService;

import { BatchJob, BatchJobService, Logger, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { SyncRequest } from '../models/sync-request';
import BatchCategoryService from './batchCategory';

type InjectedDependencies = {
  manager: EntityManager;
  batchJobService: BatchJobService;
  productCategoryService: ProductCategoryService;
  batchCategoryService: BatchCategoryService;
  logger: Logger;
};

class FixService extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;
  protected readonly batchJobService: BatchJobService;
  protected readonly batchCategoryService: BatchCategoryService;
  protected readonly logger: Logger;

  constructor({ batchJobService, productCategoryService, batchCategoryService, logger }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
    this.batchJobService = batchJobService;
    this.batchCategoryService = batchCategoryService;
    this.logger = logger;
  }

  public async fix(request: SyncRequest): Promise<BatchJob[]> {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity(`Running Fix on ${JSON.stringify(request)}`);
    const update = (message: string) => this.logger.progress(activityId, `FIX-SERVICE - ${message}`);

    update('Get Categories');
    const categories = await this.batchCategoryService.getCategories(request);

    const responses: BatchJob[] = [];
    for (const category of categories) {
      update(`Category: ${category}`);
      responses.push(
        await this.batchJobService.create({
          type: 'fix-images',
          context: { category_id: category },
          dry_run: false,
          created_by: request.user,
        }),
      );
    }

    this.logger.success(activityId, `Sync Started for ${JSON.stringify(categories)} categories`);
    return responses;
  }
}

export default FixService;

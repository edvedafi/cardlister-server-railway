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

class SyncService extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;
  protected readonly batchJobService: BatchJobService;
  protected readonly batchCategoryService: BatchCategoryService;
  protected readonly logger: Logger;

  constructor({ batchJobService, productCategoryService, logger, batchCategoryService }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
    this.batchJobService = batchJobService;
    this.batchCategoryService = batchCategoryService;
    this.logger = logger;
  }

  public async sync(request: SyncRequest): Promise<BatchJob[]> {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity(`Running Sync on ${JSON.stringify(request)}`);
    // const update = (message: string) => this.logger.progress(activityId, `SYNC - ${message}`);

    const responses: BatchJob[] = [];
    const categories = await this.batchCategoryService.getCategories(request);
    for (const category of categories) {
      if (process.env.NODE_ENV === 'development' && !request.only) {
        // update('Running TEST Sync because we are in development mode');
        responses.push(
          await this.batchJobService.create({
            type: 'test-sync',
            context: { category_id: category },
            dry_run: false,
            created_by: request.user,
          }),
        );
      } else {
        // if (!request.only || request.only.includes('sportlots')) {
        //   // update('Starting Sportlots Sync');
        //   responses.push(
        //     await this.batchJobService.create({
        //       type: 'sportlots-sync',
        //       context: { category_id: category },
        //       dry_run: false,
        //       created_by: request.user,
        //     }),
        //   );
        // }

        if (!request.only || request.only.includes('bsc')) {
          // update('Starting BSC Sync');
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
          // update('Starting Ebay Sync');
          responses.push(
            await this.batchJobService.create({
              type: 'ebay-sync',
              context: { category_id: category },
              dry_run: false,
              created_by: request.user,
            }),
          );
        }

        if (request.only && request.only.includes('mcp')) {
          // update('Starting MCP Sync');
          responses.push(
            await this.batchJobService.create({
              type: 'mcp-sync',
              context: { category_id: category },
              dry_run: false,
              created_by: request.user,
            }),
          );
        }

        if (!request.only || request.only.includes('myslabs')) {
          // update('Starting MySlabs Sync');
          responses.push(
            await this.batchJobService.create({
              type: 'myslabs-sync',
              context: { category_id: category },
              dry_run: false,
              created_by: request.user,
            }),
          );
        }

        if (request.only && request.only.includes('test')) {
          // update('Starting TEST Sync');
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
    }
    const displayableCategories = Array.from(categories);
    this.logger.success(activityId, `Sync Started for ${JSON.stringify(displayableCategories)} categories`);
    return responses;
  }
}

export default SyncService;

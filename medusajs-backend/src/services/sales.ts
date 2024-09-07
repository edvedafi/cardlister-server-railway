import { BatchJob, BatchJobService, TransactionBaseService } from '@medusajs/medusa';
import { SalesBatchRequest } from '../models/sales-batch-request';

type InjectedDependencies = {
  batchJobService: BatchJobService;
};

class SalesService extends TransactionBaseService {
  protected readonly batchJobService: BatchJobService;

  constructor({ batchJobService }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.batchJobService = batchJobService;
  }

  public async getSales(request: SalesBatchRequest): Promise<BatchJob[]> {
    const responses: BatchJob[] = [];
    if (!request.only || request.only.includes('ebay')) {
      responses.push(
        await this.batchJobService.create({
          type: 'ebay-sales-sync',
          dry_run: false,
          created_by: request.user,
          context: {},
        }),
      );
    }
    if (!request.only || request.only.includes('bsc')) {
      responses.push(
        await this.batchJobService.create({
          type: 'bsc-sales-sync',
          dry_run: false,
          created_by: request.user,
          context: {},
        }),
      );
    }
    if (!request.only || request.only.includes('sportlots')) {
      responses.push(
        await this.batchJobService.create({
          type: 'sportlots-sales-sync',
          dry_run: false,
          created_by: request.user,
          context: {},
        }),
      );
    }
    if (!request.only || request.only.includes('mcp')) {
      responses.push(
        await this.batchJobService.create({
          type: 'mcp-sales-sync',
          dry_run: false,
          created_by: request.user,
          context: {},
        }),
      );
    }
    if (request.only && request.only.includes('test')) {
      responses.push(
        await this.batchJobService.create({
          type: 'test-sales-sync',
          dry_run: false,
          created_by: request.user,
          context: {},
        }),
      );
    }

    return responses;
  }
}

export default SalesService;

import { BatchJob, BatchJobService, BatchJobStatus, TransactionBaseService } from '@medusajs/medusa';
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

    const startSync = async (type: string) => {
      const [activeBatchesResponse] = await this.batchJobService.listAndCount({
        type: [type],
      });
      if (
        !activeBatchesResponse.find(
          (job) => ![BatchJobStatus.FAILED, BatchJobStatus.CANCELED, BatchJobStatus.COMPLETED].includes(job.status),
        )
      ) {
        responses.push(
          await this.batchJobService.create({
            type,
            dry_run: false,
            created_by: request.user,
            context: {},
          }),
        );
      } else {
        console.log('Already running', type);
      }
    };

    if (!request.only || request.only.includes('ebay')) {
      await startSync('ebay-sales-sync');
    }
    if (!request.only || request.only.includes('bsc')) {
      await startSync('bsc-sales-sync');
    }
    if (!request.only || request.only.includes('sportlots')) {
      await startSync('sportlots-sales-sync');
    }
    if (!request.only || request.only.includes('mcp')) {
      await startSync('mcp-sales-sync');
    }
    if (!request.only || request.only.includes('myslabs')) {
      await startSync('myslabs-sales-sync');
    }
    if (request.only && request.only.includes('test')) {
      await startSync('test-sales-sync');
    }

    return responses;
  }
}

export default SalesService;

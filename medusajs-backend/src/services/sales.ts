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

    const startSync = async (type: string) => {
      // Filter active jobs on real timestamp columns (status is a virtual @AfterLoad
      // field — not a column) and order by recency: listAndCount defaults to take=20
      // with no ORDER BY, which over batch_job (>300k rows) returned arbitrary rows
      // and silently missed the recent active jobs, letting duplicates pile up.
      const [activeBatches] = await this.batchJobService.listAndCount(
        { type: [type], failed_at: null, completed_at: null, canceled_at: null } as never,
        { order: { created_at: 'DESC' }, take: 5 },
      );
      if (activeBatches.length === 0) {
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
    if (request.only && request.only.includes('mcp')) {
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

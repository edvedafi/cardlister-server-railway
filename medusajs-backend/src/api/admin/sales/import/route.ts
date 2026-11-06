import { BatchJobService, MedusaRequest, MedusaResponse } from '@medusajs/medusa';
import { ordersFromPullSheets, SportlotsAuthError, SportlotsParseError } from '../../../../utils/sportlots-parse';
import { SPORTLOTS_IMPORT_BATCH_TYPE } from '../../../../strategies/sportlotsImportSalesStrategy';

/**
 * Takes the HTML of one or more saved SportLots pull reports and starts a dry-run batch job. See
 * SportlotsImportSalesStrategy for what happens next.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { reports } = req.body as { reports?: unknown };
  if (!Array.isArray(reports) || reports.length === 0 || !reports.every((r) => typeof r === 'string')) {
    res.status(400).json({ message: 'reports must be a non-empty array of HTML strings' });
    return;
  }

  let orders: ReturnType<typeof ordersFromPullSheets>;
  try {
    orders = ordersFromPullSheets(reports);
  } catch (e) {
    if (e instanceof SportlotsParseError || e instanceof SportlotsAuthError) {
      res.status(400).json({ message: e.message });
      return;
    }
    throw e;
  }
  if (orders.length === 0) {
    res.status(400).json({ message: 'No sales found in the pull reports' });
    return;
  }

  const batchJobService: BatchJobService = req.scope.resolve('batchJobService');
  const batch_job = await batchJobService.create({
    type: SPORTLOTS_IMPORT_BATCH_TYPE,
    dry_run: true,
    created_by: req.user.id,
    context: { orders },
  });
  res.json({ batch_job });
}

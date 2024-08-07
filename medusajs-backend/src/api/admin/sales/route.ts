import { BatchJob, BatchJobService, MedusaRequest, MedusaResponse } from '@medusajs/medusa';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const batchJobService: BatchJobService = req.scope.resolve('batchJobService');

  const responses: BatchJob[] = [];

  const body: { only?: string[] } = req.body;

  if (!body.only || body.only.includes('ebay')) {
    responses.push(
      await batchJobService.create({
        type: 'ebay-sales-sync',
        dry_run: false,
        created_by: req.user.id,
        context: {},
      }),
    );
  }
  if (!body.only || body.only.includes('bsc')) {
    responses.push(
      await batchJobService.create({
        type: 'bsc-sales-sync',
        dry_run: false,
        created_by: req.user.id,
        context: {},
      }),
    );
  }
  if (!body.only || body.only.includes('sportlots')) {
    responses.push(
      await batchJobService.create({
        type: 'sportlots-sales-sync',
        dry_run: false,
        created_by: req.user.id,
        context: {},
      }),
    );
  }

  res.json({ status: 'ok', request: body, result: responses });
}

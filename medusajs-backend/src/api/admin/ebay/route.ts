import { BatchJob, BatchJobService, Logger, MedusaRequest, MedusaResponse } from '@medusajs/medusa';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  // const batchJobService: BatchJobService = req.scope.resolve('batchJobService');
  // const responses: BatchJob[] = [];

  try {
    const logger: Logger = req.scope.resolve('logger');
    logger.info(`EBAY::POST::Raw: ${req.body}`);
    logger.info(`EBAY::POST::JSON: ${JSON.stringify(req.body)}`);
  } catch (e) {
    console.error(`EBAY::POST::Raw: ${req.body}`);
  }

  res.json({ status: 'ok' });
}

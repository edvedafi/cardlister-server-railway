import { MedusaRequest, MedusaResponse } from '@medusajs/medusa';
import { SyncRequest } from '../../../models/sync-request';
import FixService from '../../../services/fix';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const fixService: FixService = req.scope.resolve('fixService');

  // @ts-expect-error body is untyped
  const body: SyncRequest = req.body || {
    category: 'Error: Category or bin or sku is Required',
    bin: 'Error: Category or bin or sku is Required',
    sku: 'Error: Category or bin or sku is Required',
    only: [],
  };

  const syncResult = await fixService.fix({ ...body, user: req.user.id });

  res.json({ status: 'ok', request: body, result: syncResult });
}

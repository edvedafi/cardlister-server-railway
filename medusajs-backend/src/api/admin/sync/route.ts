import { MedusaRequest, MedusaResponse } from '@medusajs/medusa';
import SyncService from '../../../services/sync';
import { SyncRequest } from '../../../models/sync-request';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const syncService: SyncService = req.scope.resolve('syncService');

  // @ts-expect-error body is untyped
  const body: SyncRequest = req.body || {};

  if (!body.category && !body.bin && !body.sku) {
    res.status(400).json({ status: 'error', message: 'At least one of category, bin, or sku is required' });
    return;
  }

  const syncResult = await syncService.sync({ ...body, user: req.user.id });

  res.json({ status: 'ok', request: body, result: syncResult });
}

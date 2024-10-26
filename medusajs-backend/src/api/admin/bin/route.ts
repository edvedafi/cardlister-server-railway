import { MedusaRequest, MedusaResponse } from '@medusajs/medusa';
import BinService from '../../../services/bin';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const binService: BinService = req.scope.resolve('binService');
  res.json({ status: 'ok', nextBin: await binService.getNextBin() });
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
}

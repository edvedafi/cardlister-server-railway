import { MedusaRequest, MedusaResponse } from '@medusajs/medusa';
import SalesService from '../../../services/sales';
import { SalesBatchRequest } from '../../../models/sales-batch-request';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body: Partial<SalesBatchRequest> = req.body;
  // const salesService: SalesService = await req.scope.resolve('salesService');

  console.log('ebay post body:', JSON.stringify(body, null, 2));

  // res.json({ status: 'ok', request: body, result: await salesService.getSales({only: body.only, user: req.user.id}) });
}

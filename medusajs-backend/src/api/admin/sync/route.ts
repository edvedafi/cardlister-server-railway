import { BatchJob, BatchJobService, MedusaRequest, MedusaResponse } from '@medusajs/medusa';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const batchJobService: BatchJobService = req.scope.resolve('batchJobService');
  const responses: BatchJob[] = [];

  // @ts-expect-error body is untyped
  const body: { category: string | string[]; only: string[] } = req.body || {
    category: 'Error: Category is Required',
    only: [],
  };

  const processCategory = async (category: string) => {
    if (!body.only || body.only.includes('sportlots')) {
      responses.push(
        await batchJobService.create({
          type: 'sportlots-sync',
          context: { category_id: category },
          dry_run: false,
          created_by: req.user.id,
        }),
      );
    }

    if (!body.only || body.only.includes('bsc')) {
      responses.push(
        await batchJobService.create({
          type: 'bsc-sync',
          context: { category_id: category },
          dry_run: false,
          created_by: req.user.id,
        }),
      );
    }

    if (!body.only || body.only.includes('ebay')) {
      responses.push(
        await batchJobService.create({
          type: 'ebay-sync',
          context: { category_id: category },
          dry_run: false,
          created_by: req.user.id,
        }),
      );
    }

    if (!body.only || body.only.includes('mcp')) {
      responses.push(
        await batchJobService.create({
          type: 'mcp-sync',
          context: { category_id: category },
          dry_run: false,
          created_by: req.user.id,
        }),
      );
    }
  };

  if (Array.isArray(body.category)) {
    for (const category of body.category) {
      await processCategory(category);
    }
  } else {
    await processCategory(body.category);
  }

  res.json({ status: 'ok', category: body.category, job: responses });
}

import {
  BatchJob,
  BatchJobService,
  Logger,
  MedusaRequest,
  MedusaResponse,
  ProductCategoryService,
} from '@medusajs/medusa';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  res.json({ status: 'ok' });
  res.sendStatus(200);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const batchJobService: BatchJobService = req.scope.resolve('batchJobService');
  const logger: Logger = req.scope.resolve('logger');
  const productCategoryService: ProductCategoryService = req.scope.resolve('productCategoryService');
  const responses: BatchJob[] = [];

  logger.log(`Processing Sync Request: ${JSON.stringify(req.body)}`);
  // @ts-expect-error body is untyped
  const body: { category: string | string[]; only: string[] } = req.body || {
    category: 'Error: Category is Required',
    only: [],
  };

  const processCategory = async (categoryId: string) => {
    logger.log(`Processing Category: ${categoryId}`);
    const category = await productCategoryService.retrieve(categoryId);
    logger.log(`Fround Category: ${category.description} => ${category.category_children?.length}`);
    if (category.category_children && category.category_children.length > 0) {
      for (const child of category.category_children) {
        await processCategory(child.id);
      }
    } else {
      await startBatchProcess(categoryId);
    }
  };

  const startBatchProcess = async (category: string) => {
    if (!body.only || body.only.includes('sportlots')) {
      logger.log('Starting Sportlots Sync');
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
      logger.log('Starting BSC Sync');
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
      logger.log('Starting Ebay Sync');
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
      logger.log('Starting MCP Sync');
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

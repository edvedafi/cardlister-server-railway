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

  const categories: Set<string> = new Set<string>();

  logger.info(`SYNC-ROUTE - Processing Sync Request: `);
  // @ts-expect-error body is untyped
  const body: {
    sku: string | string[];
    bin: string | string[];
    category: string | string[];
    only: string[];
  } = req.body || {
    category: 'Error: Category or bin or sku is Required',
    bin: 'Error: Category or bin or sku is Required',
    sku: 'Error: Category or bin or sku is Required',
    only: [],
  };

  const processCategory = async (categoryId: string) => {
    logger.info(`SYNC-ROUTE - Processing Category: ${categoryId}`);
    const category = await productCategoryService.retrieve(categoryId);
    logger.info(`SYNC-ROUTE - Fround Category: ${category.description} => ${category.category_children?.length}`);
    if (category.category_children && category.category_children.length > 0) {
      for (const child of category.category_children) {
        await processCategory(child.id);
      }
    } else {
      categories.add(categoryId);
    }
  };

  if (Array.isArray(body.category)) {
    for (const category of body.category) {
      await processCategory(category);
    }
  } else if (typeof body.category === 'string') {
    await processCategory(body.category);
  }

  //TODO Currently brute force is ok, need to move this to the service so it can be queried instead
  const [allCategories] = await productCategoryService.listAndCount({});
  type CategoryMap = { [key: string]: string };
  const categoryMap: CategoryMap = allCategories.reduce<CategoryMap>((acc: CategoryMap, c): CategoryMap => {
    if (c.metadata.bin) {
      acc[c.metadata.bin.toString()] = c.id;
    }
    return acc;
  }, {});
  const processBin = async (binId: string) => {
    logger.info(`SYNC-ROUTE - Processing Bin: ${binId}`);
    if (categoryMap[binId]) {
      await processCategory(categoryMap[binId]);
    } else {
      logger.error(`SYNC-ROUTE - Bin Not Found: ${binId}`);
    }
  };

  if (Array.isArray(body.bin)) {
    for (const bin of body.bin) {
      await processBin(bin);
    }
  } else if (typeof body.bin === 'string') {
    await processBin(body.bin);
  }

  if (Array.isArray(body.sku)) {
    for (const sku of body.sku) {
      await processBin(sku.replace('[', '').replace(']', '').split('|')[0].trim());
    }
  } else if (typeof body.bin === 'string') {
    await processBin(body.sku.replace('[', '').replace(']', '').split('|')[0].trim());
  }

  for (const category of categories) {
    if (!body.only || body.only.includes('sportlots')) {
      logger.info('SYNC-ROUTE - Starting Sportlots Sync');
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
      logger.info('SYNC-ROUTE - Starting BSC Sync');
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
      logger.info('SYNC-ROUTE - Starting Ebay Sync');
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
      logger.info('Starting MCP Sync');
      responses.push(
        await batchJobService.create({
          type: 'mcp-sync',
          context: { category_id: category },
          dry_run: false,
          created_by: req.user.id,
        }),
      );
    }
  }

  res.json({ status: 'ok', ...body, categories: categories.values(), job: responses });
}

import {
  AbstractBatchJobStrategy,
  BatchJobService,
  Logger,
  ProductCategoryService,
  ProductService,
  ProductVariantService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';

type InjectedDependencies = {
  batchJobService: BatchJobService;
  transactionManager: EntityManager;
  productService: ProductService;
  productCategoryService: ProductCategoryService;
  productVariantService: ProductVariantService;
  logger: Logger;
};

class FixImageStrategy extends AbstractBatchJobStrategy {
  static identifier = 'fix-images-strategy';
  static batchType = 'fix-images';

  private readonly productService: ProductService;
  private readonly productCategoryService: ProductCategoryService;
  private readonly productVariantService: ProductVariantService;
  private readonly logger: Logger;

  protected batchJobService_: BatchJobService;

  protected constructor(__container__: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    try {
      this.logger = __container__.logger;
      this.batchJobService_ = __container__.batchJobService || this.batchJobService_;
      this.productService = __container__.productService;
      this.productCategoryService = __container__.productCategoryService;
      this.productVariantService = __container__.productVariantService;
    } catch (e) {
      if (this.logger) {
        this.logger.error(`constructor::error`, e);
      } else {
        console.error(`constructor::error`, e);
      }
    }
  }

  async buildTemplate(): Promise<string> {
    return 'N/A';
  }

  async preProcessBatchJob(batchJobId: string): Promise<void> {
    try {
      return await this.atomicPhase_(async (transactionManager) => {
        const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);

        const category = await this.productCategoryService
          .withTransaction(transactionManager)
          .retrieve(batchJob.context.category_id as string, { relations: ['products'] });
        const count = category.products.length;

        await this.batchJobService_.withTransaction(transactionManager).update(batchJob, {
          result: {
            advancement_count: 0,
            count,
            stat_descriptors: [
              {
                key: `fix-images-update-count`,
                name: `Number of products to fix`,
                message: `${count} products will be fixed.`,
              },
            ],
          },
        });
      });
    } catch (e) {
      this.logger.log('preProcessBatchJob::error', e);
      throw e;
    }
  }

  async processJob(batchJobId: string): Promise<void> {
    return await this.atomicPhase_(async (transactionManager) => {
      let categoryId: string;
      // return await this.atomicPhase_(async (transactionManager) => {
      // const batchJob = await this.batchJobService_.retrieve(batchJobId);
      await this.atomicPhase_(async (transactionManager) => {
        const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);
        categoryId = <string>batchJob.context.category_id;
        if (batchJob.status === 'confirmed') {
          await this.batchJobService_.withTransaction(transactionManager).setProcessing(batchJobId);
        } else if (['completed', 'failed'].includes(batchJob.status)) {
          return;
        }
      });

      const category = await this.productCategoryService.retrieve(categoryId, {
        relations: ['products', 'products.variants', 'products.variants.prices', 'products.images'],
      });
      const productList = category.products;

      for (const product of productList) {
        for (const variant of product.variants) {
          const metadata = variant.metadata || {};
          if (!metadata.front_image || !metadata.back_image) {
            this.logger.info(`Adding front and back images to ${variant.sku}`);
            if (product.images && product.images.length > 1) {
              metadata.front_image = product.images[0].url.slice(product.images[0].url.lastIndexOf('/') + 1);
              metadata.back_image = product.images[1].url.slice(product.images[0].url.lastIndexOf('/') + 1);
              await this.productVariantService.update(variant.id, {
                metadata,
              });
            } else {
              this.logger.debug(`No images exist on the product ${variant.sku}`);
            }
          } else {
            this.logger.debug(`No Update for ${variant.sku}`);
          }
        }
      }

      await this.batchJobService_.withTransaction(transactionManager).update(batchJobId, {
        result: {
          advancement_count: productList.length,
        },
      });
    });
  }
}

export default FixImageStrategy;

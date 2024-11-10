import { ProductCategory, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import { CategoryMap } from '../models/category-map';

type InjectedDependencies = {
  productCategoryService: ProductCategoryService;
};

class BinService extends TransactionBaseService {
  protected readonly productCategoryService: ProductCategoryService;

  constructor({ productCategoryService }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productCategoryService = productCategoryService;
  }

  public async getNextBin(): Promise<string> {
    let maxBin = 1;

    const bins: number[] = Object.keys(await this.getAllBins()).map((bin) => parseInt(bin));
    while (bins.includes(maxBin)) {
      maxBin++;
    }
    return `${maxBin}`;
  }

  public async getAllBins(): Promise<CategoryMap> {
    const categoryMap: CategoryMap = {};
    const processCategory = async (category: ProductCategory) => {
      if (category.metadata?.bin) {
        categoryMap[category.metadata.bin.toString()] = category.id;
      }
      if (category.metadata?.deadBins) {
        (<string>category.metadata?.deadBins)
          .split(',')
          .map((deadBin) => deadBin.trim())
          .forEach((deadBin) => {
            categoryMap[deadBin] = category.id;
          });
      }
      if (category.category_children) {
        for (const child of category.category_children) {
          await processCategory(child);
        }
      }
    };
    await processCategory(await this.productCategoryService.retrieveByHandle('root'));
    return categoryMap;
  }
}

export default BinService;

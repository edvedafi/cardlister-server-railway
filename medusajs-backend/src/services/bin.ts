import { ProductCategory, ProductCategoryService, TransactionBaseService } from '@medusajs/medusa';
import _ from 'lodash';

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
    // const [categories, count] = await this.productCategoryService.listAndCount({
    //   include_descendants_tree: true,
    //   q: 'parent_category_id=null',
    // });
    // const categories = await this.productCategoryService.retrieveByHandle('root');
    // console.log('# categories count: ', count);
    // console.log('# categories bins: ', categories.filter((category) => category.metadata?.bin).length);
    // console.log('# deadBins: ', categories.filter((category) => category.metadata?.deadBins).length);
    // console.log('# categories metadata: ', categories.filter((category) => category.metadata).length);

    let maxBin = 1;

    const bins: number[] = [];
    const addBins = (category: ProductCategory) => {
      let bin: number | undefined;
      if (category.metadata?.bin || category.metadata?.deadBins) {
        console.log('category: ', category.handle, ':', category.metadata?.bin, ':', category.metadata?.deadBins);
      }
      if (category.metadata?.bin) {
        if (typeof category.metadata?.bin === 'string') {
          bin = parseInt(<string>category.metadata.bin);
        } else {
          bin = <number>category.metadata?.bin;
        }
      }
      if (bin && !bins.includes(bin)) {
        bins.push(bin);
      }
      if (category.metadata?.deadBins) {
        console.log('deadBins: ', category.metadata?.deadBins);
        (<string>category.metadata?.deadBins)
          .split(',')
          .map((deadBin) => parseInt(deadBin.trim()))
          .forEach((deadBin) => {
            if (!bins.includes(deadBin)) {
              bins.push(deadBin);
            }
          });
      }
      if (category.category_children) {
        category.category_children.forEach((child: ProductCategory) => addBins(child));
      }
    };
    addBins(await this.productCategoryService.retrieveByHandle('root'));
    // categories.forEach((category) => addBins(category));
    // const bins = categories
    //   .filter((category) => category.metadata?.bin)
    //   .map((category) =>
    //     typeof category.metadata?.bin === 'string' ? parseInt(<string>category.metadata?.bin) : category.metadata?.bin,
    //   )
    //   .concat(
    //     categories
    //       .filter((category) => category.metadata?.deadBins)
    //       .flatMap((category) => (<string>category.metadata?.deadBins).split(',').map((deadBin) => parseInt(deadBin))),
    //   );
    console.log('bins: ', _.uniq(bins).sort());
    // let cat = categories.find((category) => parseInt(<string>category.metadata?.bin) === maxBin);
    // console.log('cat: ', cat);
    while (bins.includes(maxBin)) {
      maxBin++;
      // cat = categories.find((category) => parseInt(<string>category.metadata?.bin) === maxBin);
      // console.log('cat: ', cat);
    }

    // categories.forEach((category) => {
    //   if (category.metadata?.bin) {
    //     const bin = parseInt(<string>category.metadata.bin, 10);
    //     if (bin > maxBin) {
    //       maxBin = bin;
    //     }
    //   }
    // });
    return `${maxBin}`;
  }
}

export default BinService;

import { Logger, ProductVariantService, TransactionBaseService } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { login as ebayLogin } from '../utils/ebayAPI';

type InjectedDependencies = {
  manager: EntityManager;
  productVariantService: typeof ProductVariantService;
  logger: Logger;
};

type ebayLineItem = { sku: string; quantity: number };
type ebayOrder = { buyer: { username: string }; orderFulfillmentStatus: string; lineItems: ebayLineItem[] };

class EbayService extends TransactionBaseService {
  protected readonly productVariantService: typeof ProductVariantService;
  protected readonly logger: Logger;

  constructor({ productVariantService, logger }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
    this.productVariantService = productVariantService;
    this.logger = logger;
  }

  public async getSales() {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity('Getting eBay Sales');
    const update = (message: string) => this.logger.progress(activityId, `ebay-sales - ${message}`);

    // const products = await productService.listAndCount();

    const eBay = await ebayLogin();

    //don't need to do anything with location but do need to ensure it exists
    const response = await eBay.sell.fulfillment.getOrders({
      filter: 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}',
    });

    response.orders.forEach((order: ebayOrder) => {
      update(`Checking order for ${order.buyer.username}`);
      if (order.orderFulfillmentStatus === 'FULFILLED') {
        this.logger.warn(`Order for ${order.buyer.username} already fulfilled`);
      } else {
        const items: Record<string, number> = order.lineItems.reduce(
          (acc: Record<string, number>, lineItem: ebayLineItem) => {
            acc[lineItem.sku] = lineItem.quantity;
            return acc;
          },
          {},
        );
        this.logger.info(`Order for ${order.buyer.username} contains ${JSON.stringify(items)}`);
        this.logger.info(JSON.stringify(order, null, 2));
      }
    });
  }
}

export default EbayService;

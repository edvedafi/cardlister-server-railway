import {
  CartService,
  CustomerService,
  DraftOrder,
  DraftOrderService,
  LineItem,
  Logger,
  Order,
  OrderService,
  ProductVariantService,
  RegionService,
  TransactionBaseService,
} from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import { login as ebayLogin } from '../utils/ebayAPI';
import SyncService from './sync';

type InjectedDependencies = {
  cartService: CartService;
  customerService: CustomerService;
  draftOrderService: DraftOrderService;
  orderService: OrderService;
  productVariantService: ProductVariantService;
  regionService: RegionService;
  syncService: SyncService;

  manager: EntityManager;
  logger: Logger;
};

type ebayLineItem = {
  sku: string;
  quantity: number;
  title: string;
  total: {
    value: string;
  };
};
type ebayOrder = {
  orderId: string;
  buyer: {
    username: string;
    buyerRegistrationAddress: {
      fullName: string;
      email: string;
      contactAddress: {
        addressLine1: string;
        addressLine2: string;
        city: string;
        stateOrProvince: string;
        postalCode: string;
        countryCode: string;
      };
    };
  };
  orderFulfillmentStatus: string;
  lineItems: ebayLineItem[];
};
type Item = {
  title?: string;
  unit_price?: number;
  variant_id?: string;
  quantity: number;
  metadata?: Record<string, unknown>;
};

class EbayService extends TransactionBaseService {
  protected readonly cartService: CartService;
  protected readonly customerService: CustomerService;
  protected readonly draftOrderService: DraftOrderService;
  protected readonly orderService: OrderService;
  protected readonly productVariantService: ProductVariantService;
  protected readonly regionService: RegionService;
  protected readonly syncService: SyncService;

  protected readonly logger: Logger;

  constructor({
    cartService,
    customerService,
    draftOrderService,
    orderService,
    productVariantService,
    regionService,
    syncService,
    logger,
  }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);

    this.cartService = cartService;
    this.customerService = customerService;
    this.draftOrderService = draftOrderService;
    this.orderService = orderService;
    this.productVariantService = productVariantService;
    this.logger = logger;
    this.regionService = regionService;
    this.syncService = syncService;
  }

  public async getSales() {
    // noinspection JSVoidFunctionReturnValueUsed
    const activityId = this.logger.activity('Getting eBay Sales');
    const update = (message: string) => this.logger.progress(activityId, `ebay-sales - ${message}`);

    const eBay = await ebayLogin();
    const ebayRegion = (await this.regionService.list({ name: 'ebay' }))[0].id;

    //don't need to do anything with location but do need to ensure it exists
    const response = await eBay.sell.fulfillment.getOrders({
      filter: 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}',
    });

    const orders = [];
    for (const ebayOrder of response.orders) {
      await this.atomicPhase_(async (manager) => {
        update(`Checking order for ${ebayOrder.buyer.username}`);
        this.logger.info(JSON.stringify(ebayOrder, null, 2));
        if (ebayOrder.orderFulfillmentStatus === 'FULFILLED') {
          this.logger.warn(`Order for ${ebayOrder.buyer.username} already fulfilled in ebay`);
        } else {
          const hasDraft = (await this.draftOrderService.withTransaction(manager).list({})).find(
            (draft) => draft.idempotency_key === ebayOrder.orderId,
          );

          let draftOrder: DraftOrder;
          if (hasDraft) {
            this.logger.warn(`Draft order for ${ebayOrder.buyer.username} already exists in ${hasDraft.id}`);
            if (hasDraft.status === 'open') {
              draftOrder = hasDraft;
            }

            const items: Item[] = [];
            for (const lineItem of ebayOrder.lineItems) {
              try {
                console.log('Looking for variant for ', lineItem.sku);
                const variant = await this.productVariantService.retrieveBySKU(lineItem.sku);
                console.log(`Found variant for ${lineItem.title}: `, variant);
                if (!variant) {
                  this.logger.warn(`Could not find variant for ${lineItem.sku}`);
                  items.push({
                    title: lineItem.title,
                    // variant_id: oldProductVariantId,
                    quantity: lineItem.quantity,
                    unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                    metadata: {
                      sku: lineItem.sku,
                    },
                  });
                } else {
                  items.push({
                    variant_id: variant.id,
                    quantity: lineItem.quantity,
                    unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                  });
                }
              } catch (e) {
                console.log(e);
                items.push({
                  title: lineItem.title,
                  // variant_id: oldProductVariantId,
                  quantity: lineItem.quantity,
                  unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                  metadata: {
                    sku: lineItem.sku,
                  },
                });
              }
            }
            console.log('Would have generated the following Items: ', items);
          } else {
            const items: Item[] = [];
            for (const lineItem of ebayOrder.lineItems) {
              try {
                const variant = await this.productVariantService.retrieveBySKU(lineItem.sku);
                if (!variant) {
                  this.logger.warn(`Could not find variant for ${lineItem.sku}`);
                  items.push({
                    title: lineItem.title,
                    quantity: lineItem.quantity,
                    unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                    metadata: {
                      sku: lineItem.sku,
                    },
                  });
                } else {
                  items.push({
                    variant_id: variant.id,
                    quantity: lineItem.quantity,
                    unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                  });
                }
              } catch (e) {
                items.push({
                  title: lineItem.title,
                  quantity: lineItem.quantity,
                  unit_price: parseInt(lineItem.total.value.replace('.', '').replace('$', '').trim()),
                  metadata: {
                    sku: lineItem.sku,
                  },
                });
              }
            }

            const email = ebayOrder.buyer.buyerRegistrationAddress.email;
            const customers = await this.customerService.withTransaction(manager).list({ email });
            this.logger.info(`Found ${customers.length} customers with email ${email}`);
            this.logger.info(JSON.stringify(customers, null, 2));
            const createOrderRequest = {
              customer_id: customers[0]?.id,
              email: email,
              region_id: ebayRegion,
              shipping_methods: [],
              items: items,
              no_notification_order: true,
              idempotency_key: ebayOrder.orderId,
              metadata: {
                ebayOrderId: ebayOrder.orderId,
                username: ebayOrder.buyer.username,
              },
            };
            draftOrder = await this.draftOrderService.withTransaction(manager).create(createOrderRequest);
          }

          if (draftOrder) {
            await this.cartService.withTransaction(manager).setPaymentSessions(draftOrder.cart_id);
            const cart = await this.cartService.withTransaction(manager).authorizePayment(draftOrder.cart_id, {});
            const order = await this.orderService.withTransaction(manager).createFromCart(cart.id);
            await this.draftOrderService.withTransaction(manager).registerCartCompletion(draftOrder.id, order.id);
            return draftOrder;
          }
        }
      }, 'READ UNCOMMITTED');
    }

    const skus: string[] = orders.reduce(
      (skus: string[], order: Order) =>
        skus.concat(order?.items?.map((lineItem: LineItem): string => lineItem.variant?.sku)),
      [],
    );

    this.logger.info(`Syncing ${skus} skus`);
    // await this.syncService.sync({ sku: skus, user: 'ebay' });

    this.logger.success(activityId, `Got ${orders.length} eBay sales`);
    return orders;
  }
}

export default EbayService;

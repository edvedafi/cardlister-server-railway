import { EntityManager } from 'typeorm';
import { AxiosInstance } from 'axios';
import eBayApi from 'ebay-api';
import AbstractSiteStrategy from './AbstractSiteStrategy';
import {
  Cart,
  CartService,
  CustomerService,
  DraftOrder,
  DraftOrderService,
  LineItem,
  LineItemService,
  Order,
  OrderService,
  ShippingOptionService,
} from '@medusajs/medusa';
import SyncService from '../services/sync';
import { InventoryItemService, InventoryService, ReservationItemService } from '@medusajs/inventory/dist/services';
import { PuppeteerHelper } from '../utils/puppeteer-helper';

type InjectedDependencies = {
  transactionManager: EntityManager;
  draftOrderService: DraftOrderService;
  customerService: CustomerService;
  cartService: CartService;
  orderService: OrderService;
  syncService: SyncService;
  reservationItemService: ReservationItemService;
  inventoryService: InventoryService;
  inventoryItemService: InventoryItemService;
  lineItemService: LineItemService;
  shippingOptionService: ShippingOptionService;
  listModules: () => string[];
};

type Item = {
  title?: string;
  unit_price?: number;
  variant_id?: string;
  quantity: number;
  metadata?: Record<string, unknown>;
};

export type SystemOrder = {
  id: string;
  customer: {
    email: string;
    name?: string;
    username: string;
  };
  packingSlip?: string;
  lineItems: {
    title: string;
    unit_price?: number;
    quantity: number;
    sku: string;
    cardNumber?: string;
  }[];
};

abstract class SaleStrategy<T extends AxiosInstance | eBayApi | PuppeteerHelper> extends AbstractSiteStrategy<T> {
  static identifier = 'sales-strategy';
  static batchType = 'sales-sync';
  static listingSite = 'sync-site';
  private readonly draftOrderService: DraftOrderService;
  private readonly customerService: CustomerService;
  private readonly cartService: CartService;
  private readonly orderService: OrderService;
  private readonly syncService: SyncService;
  private readonly inventoryService: InventoryService;
  private readonly lineItemService: LineItemService;
  private readonly shippingOptionService: ShippingOptionService;
  private shippingOption: string;

  // private readonly reservationItemService: ReservationItemService;

  protected constructor(__container__: InjectedDependencies) {
    // @ts-expect-error super call
    // eslint-disable-next-line prefer-rest-params
    super(...arguments);
    try {
      // listModules('*syncService*').forEach((service) => {
      //   this.log(`Available Service: ${service.name} at ${service.path}`);
      // });
      this.draftOrderService = __container__.draftOrderService;
      this.customerService = __container__.customerService;
      this.cartService = __container__.cartService;
      this.orderService = __container__.orderService;
      this.syncService = __container__.syncService;
      this.inventoryService = __container__.inventoryService;
      // this.inventoryItemService = __container__.inventoryItemService;
      this.lineItemService = __container__.lineItemService;
      this.shippingOptionService = __container__.shippingOptionService;
    } catch (e) {
      this.log(`${(<typeof SaleStrategy>this.constructor).identifier}::constructor::error`, e);
    }
  }

  async preProcessBatchJob(batchJobId: string): Promise<void> {
    try {
      return await this.atomicPhase_(async (transactionManager) => {
        const batchJob = await this.batchJobService_.withTransaction(transactionManager).retrieve(batchJobId);

        await this.batchJobService_.withTransaction(transactionManager).update(batchJob, {
          result: {
            advancement_count: 0,
            count: 0,
            stat_descriptors: [
              {
                key: `${(<typeof SaleStrategy>this.constructor).identifier}-update-count`,
                name: `Number Of Orders to create from ${(<typeof SaleStrategy>this.constructor).listingSite}`,
                message: `Orders will be published.`,
              },
            ],
          },
        });
      });
    } catch (e) {
      this.log('preProcessBatchJob::error', e);
      throw e;
    }
  }

  async processJob(batchJobId: string): Promise<void> {
    let api: T;
    try {
      this.progress(`${(<typeof AbstractSiteStrategy>this.constructor).identifier}::${batchJobId}::Gathering Sales`);

      this.progress('Login');
      api = await this.login();
      await this.getRegionId();

      this.progress('Getting Orders');
      let systemOrders: SystemOrder[];
      try {
        systemOrders = (await this.getOrders(api))
          .map((order) => ({
            ...order,
            lineItems: order.lineItems.filter((li) => li.sku),
          }))
          .filter((order) => order.lineItems.length > 0);
      } catch (e) {
        if ('screenshot' in api) {
          await api.screenshot();
        }
        throw e;
      }
      this.log(`Converting ${systemOrders.length} Orders`);

      const orders: Order[] = [];
      for (const systemOrder of systemOrders) {
        await this.atomicPhase_(async () => {
          const items: Item[] = [];
          const hasDraft = (await this.draftOrderService.list({})).find(
            (draft) => draft.idempotency_key === systemOrder.id,
          );

          let draftOrder: DraftOrder;
          if (hasDraft) {
            this.log(`Draft order ${hasDraft.idempotency_key} already exists in ${hasDraft.id}`);
            if (hasDraft.status === 'open') {
              draftOrder = hasDraft;
            }
          } else {
            this.progress('Converting Orders');
            for (const lineItem of systemOrder.lineItems) {
              try {
                this.log(`Looking for variant for ${lineItem.sku}`);
                const variant = await this.productVariantService_.retrieveBySKU(lineItem.sku, {});
                if (!variant) {
                  this.log(`Could not find variant for ${lineItem.sku}`);
                  items.push({
                    title: lineItem.title,
                    quantity: lineItem.quantity,
                    unit_price: lineItem.unit_price || 99,
                    metadata: {
                      sku: lineItem.sku,
                    },
                  });
                } else {
                  this.log(`Found variant ${variant.id} for ${lineItem.sku}`);
                  items.push({
                    variant_id: variant.id,
                    quantity: lineItem.quantity,
                    unit_price: lineItem.unit_price || this.getPrice(variant),
                    metadata: {
                      sku: lineItem.sku,
                    },
                  });
                }
              } catch (e) {
                this.log(
                  `Error looking for variant for ${lineItem.sku}, saving record as an old school sale ${e.message}`,
                );
                items.push({
                  title: lineItem.title,
                  quantity: lineItem.quantity,
                  unit_price: lineItem.unit_price || 99,
                  metadata: {
                    sku: lineItem.sku,
                  },
                });
              }
            }

            this.progress('Creating Draft');
            const customers = await this.customerService.list({ email: systemOrder.customer.email });
            const createOrderRequest = {
              customer_id: customers[0]?.id,
              email: systemOrder.customer.email,
              region_id: await this.getRegionId(),
              shipping_methods: [{ option_id: await this.getShippingOption() }],
              items: items,
              no_notification_order: true,
              idempotency_key: systemOrder.id,
              metadata: {
                username: systemOrder.customer.username,
                platform: `${(<typeof SaleStrategy>this.constructor).listingSite} - ${systemOrder.customer.username}`,
              },
            };
            draftOrder = await this.draftOrderService.create(createOrderRequest);
            this.progress(`Created Draft Order ${draftOrder.id}`);
          }

          if (draftOrder) {
            if (draftOrder.order_id) {
              this.progress(`Order exists, returning it (${draftOrder.order_id})`);
              return await this.orderService.retrieve(draftOrder.order_id);
            } else {
              let cart: Cart;
              let order: Order;
              try {
                this.progress(`Converting Draft Order ${draftOrder.id}`);
                cart = await this.cartService.retrieve(draftOrder.cart_id);
                if (!cart?.payment_authorized_at) {
                  try {
                    this.progress(`Setting Payment Sessions for Draft Order cart_id ${draftOrder.cart_id}`);
                    await this.cartService.setPaymentSessions(draftOrder.cart_id);
                  } catch (e) {
                    this.log(`Error setting payment sessions for draft ${draftOrder.id}`, e);
                    throw e;
                  }
                  try {
                    this.progress(`Authorizing Payment for Draft Order cart_id ${draftOrder.cart_id}`);
                    cart = await this.cartService.authorizePayment(draftOrder.cart_id, {});
                  } catch (e) {
                    this.log(`Error authorizing payment for draft ${draftOrder.id}`, e);
                    throw e;
                  }
                  // try {
                  //   cart = await this.cartService.addShippingMethod(draftOrder.cart_id, );
                  // } catch (e) {
                  //   this.log(`Error authorizing payment for draft ${draftOrder.id}`, e);
                  //   throw e;
                  // }
                }
                try {
                  this.progress(`Creating Order from Cart ${cart.id}`);
                  order = await this.orderService.createFromCart(cart.id);
                } catch (e) {
                  this.log(`Error creating order from cart ${cart.id}`, e);
                  throw e;
                }
                // try {
                //   await this.orderService.addShippingMethod(order.id, cart.shipping_methods[0].id);
                // } catch (e) {
                //   this.log(`Error adding shipping method to order ${order.id}`, e);
                //   throw e;
                // }
                try {
                  this.progress(`Registering Cart Completion for Draft Order ${draftOrder.id}`);
                  await this.draftOrderService.registerCartCompletion(draftOrder.id, order.id);
                } catch (e) {
                  this.log(`Error registering cart completion for draft ${draftOrder.id}`, e);
                  throw e;
                }
                try {
                  this.progress(`Capturing Payment for Draft Order ${draftOrder.id}`);
                  order = await this.orderService.capturePayment(order.id);
                } catch (e) {
                  this.log(`Error capturing payment for draft ${draftOrder.id}`, e);
                  throw e;
                }
                this.progress(`Order Created: ${order.id}`);
                orders.push(order);
              } catch (e) {
                this.log(`Draft Order: ${JSON.stringify(draftOrder, null, 2)}`);
                if (cart) {
                  this.log(`Cart: ${JSON.stringify(cart, null, 2)}`);
                } else {
                  this.log('No Cart');
                }
                if (order) {
                  this.log(`Order: ${JSON.stringify(order, null, 2)}`);
                } else {
                  this.log('No Order');
                }
                //TODO Need to handle in a trackable way
                this.log(`Error creating order from draft ${draftOrder.id}`, e);
              }
            }
          }
        }, 'READ UNCOMMITTED');
      }

      this.progress('Syncing Categories');
      const listedItems = (
        await Promise.all(
          orders
            .filter((o) => o)
            .map(async (order): Promise<LineItem[]> => await this.lineItemService.list({ order_id: order.id })),
        )
      ).flat();
      this.log(`Listed Items: ${JSON.stringify(listedItems, null, 2)}`);
      const skus: string[] = listedItems
        .map((item: Item): string | null => (item.variant_id ? <string>item.metadata.sku : null))
        .filter((sku) => sku);
      const count = listedItems.reduce((count, li) => count + li.quantity, 0);

      if (skus.length > 0) {
        const location = await this.getLocationId();
        const reservations = [];
        for (const item of listedItems) {
          if (item.variant_id) {
            reservations.push({
              line_item_id: item.id,
              inventory_item_id: (
                await this.inventoryService.listInventoryItems({
                  sku: item.metadata.sku,
                  location_id: location,
                })
              )[0][0].id,
              quantity: item.quantity,
              location_id: location,
            });
          }
        }
        this.log(`Items: ${JSON.stringify(reservations, null, 2)}`);
        await this.inventoryService.createReservationItems(reservations);
        const batchJob = await this.batchJobService_.retrieve(batchJobId);
        await this.syncService.sync({
          sku: skus,
          user: batchJob.created_by,
          // only: ['test'],
        });
      }

      if (count > 0) {
        this.finishProgress(`Sold ${count} Cards`);
      } else {
        this.finishProgress('No Cards Sold');
      }
    } catch (e) {
      this.progress('SalesStrategy::ProcessJob::error', e);
      throw e;
    } finally {
      await this.logout(api);
    }
  }

  abstract getOrders(api: T): Promise<SystemOrder[]>;

  private async getShippingOption(): Promise<string> {
    if (!this.shippingOption) {
      const shippingOptions = await this.shippingOptionService.list({
        region_id: await this.getRegionId(),
      });
      this.shippingOption = shippingOptions[0]?.id;
      if (!this.shippingOption) {
        throw new Error(`No ShippingOption Found for ${(<typeof AbstractSiteStrategy>this.constructor).listingSite}`);
      }
    }
    return this.shippingOption;
  }
}

export default SaleStrategy;

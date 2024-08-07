import { EntityManager } from 'typeorm';
import { AxiosInstance } from 'axios';
import eBayApi from 'ebay-api';
import AbstractSiteStrategy from './AbstractSiteStrategy';
import {
  CartService,
  CustomerService,
  DraftOrder,
  DraftOrderService,
  LineItem,
  LineItemService,
  OrderService,
} from '@medusajs/medusa';
import SyncService from '../services/sync';
import { InventoryItemService, InventoryService, ReservationItemService } from '@medusajs/inventory/dist/services';

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
    username: string;
  };
  lineItems: {
    title: string;
    unit_price: number;
    quantity: number;
    sku: string;
  }[];
};

abstract class SaleStrategy<T extends WebdriverIO.Browser | AxiosInstance | eBayApi> extends AbstractSiteStrategy<T> {
  static identifier = 'sales-strategy';
  static batchType = 'sales-sync';
  static listingSite = 'sync-site';
  private readonly draftOrderService: DraftOrderService;
  private readonly customerService: CustomerService;
  private readonly cartService: CartService;
  private readonly orderService: OrderService;
  private readonly syncService: SyncService;
  private readonly inventoryService: InventoryService;
  private readonly inventoryItemService: InventoryItemService;
  private readonly lineItemService: LineItemService;
  // private readonly reservationItemService: ReservationItemService;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      // console.log(__container__.reservationItemService);
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
    try {
      this.progress(`${(<typeof AbstractSiteStrategy>this.constructor).identifier}::${batchJobId}::Gathering Sales`);

      this.progress('Login');
      const api: T = await this.login();
      await this.getRegionId();

      this.progress('Getting Orders');
      const systemOrders = (await this.getOrders(api))
        .map((order) => ({
          ...order,
          lineItems: order.lineItems.filter((li) => li.sku),
        }))
        .filter((order) => order.lineItems.length > 0);

      const orders = await Promise.all(
        systemOrders.map((systemOrder) =>
          this.atomicPhase_(async (manager) => {
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
                      unit_price: lineItem.unit_price,
                      metadata: {
                        sku: lineItem.sku,
                      },
                    });
                  } else {
                    this.log(`Found variant ${variant.id} for ${lineItem.sku}`);
                    items.push({
                      variant_id: variant.id,
                      quantity: lineItem.quantity,
                      unit_price: lineItem.unit_price,
                      metadata: {
                        sku: lineItem.sku,
                      },
                    });
                  }
                } catch (e) {
                  this.log(`Error looking for variant for ${lineItem.sku}`, e);
                  items.push({
                    title: lineItem.title,
                    quantity: lineItem.quantity,
                    unit_price: lineItem.unit_price,
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
                shipping_methods: [],
                items: items,
                no_notification_order: true,
                idempotency_key: systemOrder.id,
                metadata: {
                  username: systemOrder.customer.username,
                  platform: `${(<typeof SaleStrategy>this.constructor).listingSite} - ${systemOrder.customer.username}`,
                },
              };
              draftOrder = await this.draftOrderService.create(createOrderRequest);
            }

            if (draftOrder) {
              if (draftOrder.order_id) {
                return await this.orderService.retrieve(draftOrder.order_id);
              } else {
                await this.cartService.setPaymentSessions(draftOrder.cart_id);
                const cart = await this.cartService.authorizePayment(draftOrder.cart_id, {});
                const order = await this.orderService.createFromCart(cart.id);
                await this.draftOrderService.registerCartCompletion(draftOrder.id, order.id);
                return {
                  ...order,
                  items,
                };
              }
            }
          }, 'READ UNCOMMITTED'),
        ),
      );

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
          only: ['test'],
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
    }
  }

  abstract getOrders(api: T): Promise<SystemOrder[]>;
}

export default SaleStrategy;

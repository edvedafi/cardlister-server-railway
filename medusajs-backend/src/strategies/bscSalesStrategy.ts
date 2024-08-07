import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { AxiosInstance } from 'axios';
import { login as bscLogin } from '../utils/bsc';

type Address = {
  id: string;
  firstName: string;
  lastName: string;
  addressLine1: string;
  city: string;
  state: string;
  country: string;
  zipCode: string;
};

type SellerProfile = {
  sellerId: string;
  sellerStoreName: string;
  totalQuantity: number;
  storePhoneNumber: string;
  storeAddress: Address;
  applicationStatus: string;
  userId: string;
  salesNumber: number;
  shipmentCost: number;
  inventoryStatus: boolean;
};

type Seller = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  roleId: string;
  email: string;
  stripeCustomerId: string;
  sellerProfile: SellerProfile;
};

type BuyerProfile = {
  shippingAddresses: Address[];
};

type Buyer = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  roleId: string;
  email: string;
  stripeCustomerId: string;
  buyerProfile: BuyerProfile;
};

type Card = {
  setName: string;
  players: string;
  cardNo: string;
  cardNoOrder: number;
  cardNoSequence: number;
  variant: string;
  variantName: string;
  sport: string;
  year: string;
  playerAttribute: string;
  playerAttributeDesc: string;
  stockImgFront: string;
  stockImgBack: string;
  lowestPrice: number;
  id: string;
};

type OrderItem = {
  productId: string;
  sellerImgFront: string;
  sellerImgBack: string;
  productType: string;
  cardId: string;
  price: string;
  condition: string;
  availableQuantity: number;
  orderQuantity: number;
  active: boolean;
  shippingCost: string;
  currency: string;
  cartQty: number;
  card: Card;
  sellerId: string;
  lastSoldPrice: number;
  sportId: string;
  sellerInventoryStatus: boolean;
  updatedTimestamp: string;
  sellerSku: string;
  cardYear: number;
  imageChanged: boolean;
};

type Refund = unknown;

type Order = {
  orderNo: string;
  confirmationNumber: string;
  orderDate: string;
  subTotal: string;
  orderSubtotal: number;
  shippingRefundable: number;
  subtotalRefundable: number;
  refundTotal: number;
  shippingRefundTotal: number;
  shippingCost: string;
  salesTax: string;
  sellerFee: string;
  orderCurrency: string;
  total: string;
  buyerDiscountAmount: string;
  sellerNetTotal: string;
  orderStatus: string;
  numberOfPackages: number;
  stripeTransactionId: string;
  shippingAddressId: string;
  billingAddressId: string;
  stripePaymentId: string;
  stripePaymentFee: string;
  userId: string;
  sellerId: string;
  shippingAddress: Address;
  billingAddress: Address;
  seller: Seller;
  buyer: Buyer;
  orderItems: OrderItem[];
  refunds: Refund[];
  orderId: string;
};

abstract class BSCSalesStrategy extends SaleStrategy<AxiosInstance> {
  static identifier = 'bsc-sales-strategy';
  static batchType = 'bsc-sales-sync';
  static listingSite = 'BSC';

  // // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // protected constructor(__container__: unknown) {
  //   // eslint-disable-next-line prefer-rest-params
  //   super(arguments[0]);
  // }

  async login(): Promise<AxiosInstance> {
    return bscLogin(this.loginAxios);
  }

  async getOrders(api: AxiosInstance): Promise<SystemOrder[]> {
    const historyResponse = await api.post('seller/order/history', {
      name: '',
      orderNo: '',
      fromDate: null,
      toDate: null,
      page: 0,
      size: 5,
      status: ['READY_TO_SHIP', 'PARTIALLY_REFUNDED_READY_TO_SHIP'],
    });
    const history = historyResponse.data.results || [];

    return await Promise.all(
      history.map(async (order: Order) => {
        const orderDetailsResponse = await api.get(`seller/order/${order.orderId}`);

        const orderItems = orderDetailsResponse.data.orderItems || [];

        return {
          id: order.orderId,
          customer: {
            email: order.buyer.email,
            username: order.buyer.username,
          },
          lineItems: orderItems.map((item: OrderItem) => ({
            title: `${item.card.setName}${item.card.variantName ? ' ' + item.card.variantName : ''} #${item.card.cardNo} ${item.card.players}`,
            quantity: item.orderQuantity,
            sku: item.sellerSku,
          })),
        };
      }),
    );
  }
}

export default BSCSalesStrategy;

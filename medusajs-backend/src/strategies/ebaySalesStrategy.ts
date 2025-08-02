import eBayApi from 'ebay-api';
import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { login as ebayLogin } from '../utils/ebayAPI';

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

abstract class EbaySalesStrategy extends SaleStrategy<eBayApi> {
  static identifier = 'ebay-sales-strategy';
  static batchType = 'ebay-sales-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected constructor(__container__: unknown) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
  }

  async login(): Promise<eBayApi> {
    return ebayLogin();
  }

  async getOrders(eBay: eBayApi): Promise<SystemOrder[]> {
    const response = await eBay.sell.fulfillment.getOrders({
      filter: 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}',
    });
    return response.orders.map((ebayOrder: ebayOrder) => ({
      id: ebayOrder.orderId,
      customer: {
        email: ebayOrder.buyer.buyerRegistrationAddress.email,
        username: ebayOrder.buyer.username,
      },
      lineItems: ebayOrder.lineItems.map((li) => ({
        title: li.title,
        unit_price: parseInt(li.total.value?.replace('.', '').replace('$', '').trim() || ''),
        quantity: li.quantity,
        sku: li.sku?.replace('_', '|') || 'NA',
      })),
    }));
  }
}

export default EbaySalesStrategy;

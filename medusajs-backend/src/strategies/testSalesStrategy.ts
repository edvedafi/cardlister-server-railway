import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import axios, { AxiosInstance } from 'axios';
import _ from 'lodash';

abstract class TestSalesStrategy extends SaleStrategy<AxiosInstance> {
  static identifier = 'test-sales-strategy';
  static batchType = 'test-sales-sync';
  static listingSite = 'ebay';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected constructor(__container__: unknown) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0]);
  }

  async login(): Promise<AxiosInstance> {
    return axios.create({});
  }

  async getOrders(): Promise<SystemOrder[]> {
    return [
      {
        id: _.uniqueId('test-order-11-'),
        customer: {
          email: 'jburich+test@gmail.com',
          username: 'jburich',
        },
        lineItems: [
          {
            title: 'testing 1',
            unit_price: 199,
            quantity: 3,
            sku: '910|CS-20',
          },
        ],
      },
    ];
  }
}

export default TestSalesStrategy;

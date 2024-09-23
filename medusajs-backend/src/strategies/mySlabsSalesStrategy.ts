import SaleStrategy, { SystemOrder } from './AbstractSalesStrategy';
import { AxiosInstance } from 'axios';
import { login, Slab } from '../utils/mySlabs';

abstract class MySlabSalesStrategy extends SaleStrategy<AxiosInstance> {
  static identifier = 'myslabs-sales-strategy';
  static batchType = 'myslabs-sales-sync';
  static listingSite = 'MySlabs';

  async login(): Promise<AxiosInstance> {
    return login(this.loginAxios);
  }

  async getOrders(api: AxiosInstance): Promise<SystemOrder[]> {
    const { data } = await api.get('/my/slabs?status=sold&sort=completion_date_desc&page=1&page_count=5');

    return await Promise.all(
      data
        .filter((sale: Slab) => sale.external_id)
        .map(async (order: Slab) => {
          return {
            id: `myslab-${order.id}`,
            customer: {
              email: 'jburich@gmail.com',
              username: 'unknown',
            },
            lineItems: [
              {
                title: order.title,
                quantity: 1,
                sku: order.external_id,
              },
            ],
          };
        }),
    );
  }
}

export default MySlabSalesStrategy;

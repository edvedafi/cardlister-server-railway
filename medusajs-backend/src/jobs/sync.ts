import { ProductCategoryService, ScheduledJobArgs, ScheduledJobConfig, UserService } from '@medusajs/medusa';
import SyncService from '../services/sync';

export default async function handler({ container }: ScheduledJobArgs) {
  const userService: UserService = container.resolve('userService');
  const syncService: SyncService = container.resolve('syncService');
  const productCategoryService: ProductCategoryService = container.resolve('productCategoryService');
  const root = await productCategoryService.retrieveByHandle('root');
  await syncService.sync({
    user: (await userService.retrieveByEmail('jburich@gmail.com')).id,
    only: null,
    category: root.id,
  });
}

export const config: ScheduledJobConfig = {
  name: 'sync-all',
  //run at 6 am
  schedule: '0 3 * * *',
};

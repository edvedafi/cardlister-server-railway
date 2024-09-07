import { ScheduledJobArgs, ScheduledJobConfig, UserService } from '@medusajs/medusa';
import SalesService from '../services/sales';

export default async function handler({ container }: ScheduledJobArgs) {
  const salesService: SalesService = container.resolve('salesService');
  const userService: UserService = container.resolve('userService');
  await salesService.getSales({ user: (await userService.retrieveByEmail('jburich@gmail.com')).id });
}

export const config: ScheduledJobConfig = {
  name: 'gather-sales',
  schedule: process.env.NODE_ENV === 'development' ? '' : '*/15 * * * *', // Every 15 minutes
};

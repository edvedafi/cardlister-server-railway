// src/loaders/my-loader.ts

import { AwilixContainer } from 'awilix';
import { login } from '../utils/ebayAPI';
import eBayApi from 'ebay-api';

/**
 *
 * @param container The container in which the registrations are made
 * @param config The options of the plugin or the entire config object
 */
export default (container: AwilixContainer, config: Record<string, unknown>): void | Promise<void> => {
  login()
    .then((eBay: eBayApi) => {
      eBay.trading
        .SetNotificationPreferences({
          ApplicationDeliveryPreferences: {
            ApplicationEnable: 'Enable',
            ApplicationURL: 'https://medusajs-backend-production-0782.up.railway.app/admin/ebay',
            DeviceType: 'Platform',
            PayloadVersion: 1173,
          },
          UserDeliveryPreferenceArray: {
            NotificationEnable: [
              {
                EventEnable: 'Enable',
                EventType: 'AuctionCheckoutComplete',
              },
            ],
          },
        })
        .then((res) => {
          console.log(res);
        })
        .catch((err) => {
          console.error(err);
        });
    })
    .catch((err) => {
      console.error(err);
    });
};

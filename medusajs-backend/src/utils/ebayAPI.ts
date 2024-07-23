import process from 'node:process';
import eBayApi from 'ebay-api';
import fs from 'fs-extra';

async function getRefreshToken() {
  // TODO PROVIDE AN EBAY LOGIN SCREEN
  if (process.env.EBAY_TOKEN) {
    return JSON.parse(process.env.EBAY_TOKEN);
  } else {
    return fs.readJsonSync('.ebay');
  }
}

export async function login(): Promise<eBayApi> {
  const eBay = eBayApi.fromEnv();

  eBay.OAuth2.setScope([
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    // 'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.email.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.phone.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.address.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.name.readonly',
    // 'https://api.ebay.com/oauth/api_scope/commerce.identity.status.readonly',
    // 'https://api.ebay.com/oauth/api_scope/sell.finances',
    // 'https://api.ebay.com/oauth/api_scope/sell.item.draft',
    ////////////'https://api.ebay.com/oauth/api_scope/sell.item',
    // 'https://api.ebay.com/oauth/api_scope/sell.reputation',
  ]);

  const token = await getRefreshToken();
  if (!token) {
    throw new Error('No eBay Token Found');
  }

  eBay.OAuth2.setCredentials(token);

  return eBay;
}

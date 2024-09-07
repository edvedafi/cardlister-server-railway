import { useSpinners } from '../utils/spinners';
import { remote } from 'webdriverio';
import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { ask } from '../utils/ask';
import type { Aggregations, Card, Filter, FilterParams, Filters } from '../models/bsc';
import type { Category, SetInfo } from '../models/setInfo';
import { getBrowserlessConfig } from '../utils/browserless';

const { showSpinner, log } = useSpinners('bsc', '#e5e5e5');

let _api: AxiosInstance;

async function login() {
  if (!_api) {
    // const browser = await remote({
    //   capabilities: {
    //     browserName: 'chrome',
    //     'goog:chromeOptions': {
    //       args: ['headless', 'disable-gpu', '--window-size=1200,2000'],
    //     },
    //     browserVersion: '126',
    //   },
    //   logLevel: 'error',
    // });

    const browser = await remote(getBrowserlessConfig('https://www.buysportscards.com/', 'BSC_LOG_LEVEL'));

    try {
      await browser.url('https://www.buysportscards.com');
      const signInButton = await browser.$('.=Sign In');
      await signInButton.waitForClickable({ timeout: 10000 });
      await signInButton.click();

      const emailInput = await browser.$('#signInName');
      await emailInput.waitForExist({ timeout: 5000 });
      await emailInput.setValue(process.env.BSC_EMAIL as string);
      await browser.$('#password').setValue(process.env.BSC_PASSWORD as string);

      await browser.$('#next').click();

      await browser.$('.=welcome back,').waitForExist({ timeout: 10000 });

      const reduxAsString: string = await browser.execute(
        'return Object.values(localStorage).filter((value) => value.includes("secret")).find(value=>value.includes("Bearer"));',
      );
      const redux = JSON.parse(reduxAsString);

      _api = axios.create({
        baseURL: 'https://api-prod.buysportscards.com/',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          assumedrole: 'sellers',
          'content-type': 'application/json',
          origin: 'https://www.buysportscards.com',
          referer: 'https://www.buysportscards.com/',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': 'macOS',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
          authority: 'api-prod.buysportscards.com',
          authorization: `Bearer ${redux.secret.trim()}`,
        },
      });
    } catch (e) {
      log(e);
      await browser.saveScreenshot('.error.png');
    } finally {
      await browser.deleteSession();
    }

    axiosRetry(_api, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
  }
  return _api;
}

export async function getBSCCards(setInfo: Category): Promise<Card[]> {
  const { update, finish } = showSpinner('get-bsc-cards', `Getting BSC Cards for ${setInfo.handle}`);
  const api = await login();
  update('Getting Listings');

  let total = 1;
  let page = 0;
  const pageSize = 100;
  let cards: Card[] = [];

  while (page * pageSize < total) {
    const body = {
      condition: 'all',
      myInventory: 'false',
      page,
      sellerId: 'cf987f7871',
      size: pageSize,
      sort: 'default',
      ...setInfo.metadata?.bsc,
    };
    const response = await api.post(`search/seller/results`, body);
    cards = cards.concat(response.data.results);
    total = response.data.totalResults;
    page++;
  }
  finish(`Found ${cards.length} cards`);
  return cards;
}

export interface BSCFilterResponse {
  name: keyof Filters | 'Base';
  filter: Filter[] | FilterParams;
}

const getNextFilter = async (
  filters: FilterParams,
  text: string,
  filterType: keyof Filters,
  defaultValue?: string,
): Promise<BSCFilterResponse> => {
  const { finish, error } = showSpinner('setFilter', `Getting BSC Variant Name Filter`);
  let rtn: BSCFilterResponse = { name: filterType, filter: filters };
  try {
    const api = await login();
    const { data: filterOptions } = await api.post<Aggregations>('search/bulk-upload/filters', filters);
    const filteredFilterOptions = filterOptions.aggregations[filterType].filter((option: Filter) => option.count > 0);
    if (filteredFilterOptions.length > 1) {
      const response = await ask(text, defaultValue, {
        selectOptions: filteredFilterOptions
          .map((variant) => ({
            name: variant.label,
            value: variant,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      finish();
      rtn = {
        name: response.label,
        filter:
          response.label === 'Base' || filterType === 'variantName'
            ? {
                filters: {
                  ...filters.filters,
                  [filterType]: [response.slug],
                },
              }
            : [response.slug],
      };
    } else if (filteredFilterOptions.length === 1) {
      finish();
      rtn = { name: filteredFilterOptions[0].label, filter: [filteredFilterOptions[0].slug] };
    } else {
      throw `Failed to find BSC Filter option for ${filterType}`;
    }
  } catch (e) {
    error(e);
  }
  return rtn;
};

export const buildBSCFilters = (searchInfo: Partial<SetInfo>) =>
  searchInfo.variantName?.metadata?.bsc || {
    filters: {
      sport: searchInfo.sport?.metadata?.bsc,
      year: searchInfo.year?.metadata?.bsc,
      setName: searchInfo.set?.metadata?.bsc,
      variant: searchInfo.variantType?.metadata?.bsc,
    },
  };

export const getBSCSportFilter = async (searchSport: string) =>
  getNextFilter(buildBSCFilters({}), 'BSC Sport', 'sport', searchSport);
export const getBSCYearFilter = (searchYear: string) => [searchYear];
export const getBSCSetFilter = async (searchInfo: Partial<SetInfo>) =>
  getNextFilter(buildBSCFilters(searchInfo), 'BSC Set', 'setName');
export const getBSCVariantTypeFilter = async (searchInfo: Partial<SetInfo>) =>
  getNextFilter(buildBSCFilters(searchInfo), 'BSC Variant Type', 'variant');
export const getBSCVariantNameFilter = async (searchInfo: Partial<SetInfo>) =>
  getNextFilter(buildBSCFilters(searchInfo), 'BSC Variant Name', 'variantName');

import { useSpinners } from '../utils/spinners';
import { remote } from 'webdriverio';
import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { ask } from '../utils/ask';
import type { Aggregations, Card, Filter, FilterParams, Filters } from '../models/bsc';
import type { Category, SetInfo } from '../models/setInfo';
import { getBrowserlessConfig } from '../utils/browserless';
import { retryWithExponentialBackoff } from '../utils/retry';

const { showSpinner, log } = useSpinners('bsc', '#e5e5e5');

let _api: AxiosInstance | undefined;

async function performLogin(): Promise<AxiosInstance> {
  // Always create a new browser session for login
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

    const api = axios.create({
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
    axiosRetry(api, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
    return api;
  } catch (e) {
    console.error(`[BSC Login] Login error during performLogin:`, e);
    log(`[BSC Login] Login error: ${e}`);
    try {
      await browser.saveScreenshot('.error.png');
      console.log(`[BSC Login] Saved error screenshot to .error.png`);
    } catch (screenshotError) {
      // Ignore screenshot errors
      console.error(`[BSC Login] Could not save screenshot:`, screenshotError);
    }
    throw e; // Re-throw to trigger retry
  } finally {
    try {
      await browser.deleteSession();
    } catch (deleteError) {
      // Ignore delete errors
    }
  }
}

async function login(): Promise<AxiosInstance> {
  if (!_api) {
    _api = await retryWithExponentialBackoff(
      performLogin,
      3,
      1000,
      2,
      10000,
      async (attempt, error, delayMs) => {
        console.error(`[BSC Login Retry] Login failed (attempt ${attempt}/3):`, error);
        log(`[BSC Login Retry] Login failed (attempt ${attempt}/3): ${error}`);
        console.log(`[BSC Login Retry] Retrying BSC login in ${delayMs}ms...`);
        log(`[BSC Login Retry] Retrying in ${delayMs}ms...`);
        // Reset _api to undefined so we can retry
        _api = undefined;
      }
    );
  }
  // _api is guaranteed to be set here (either from cache or from retryWithExponentialBackoff)
  return _api!;
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
  const { finish, error, update } = showSpinner('setFilter', `Getting BSC Variant Name Filter`);
  let rtn: BSCFilterResponse = { name: filterType, filter: filters };
  try {
    update('Logging in to BSC...');
    const api = await login();
    update('Fetching filter options...');
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
      sport: searchInfo.sport?.metadata?.bsc
        ? Array.isArray(searchInfo.sport.metadata.bsc)
          ? searchInfo.sport.metadata.bsc
          : [searchInfo.sport.metadata.bsc]
        : undefined,
      year: searchInfo.year?.metadata?.bsc
        ? Array.isArray(searchInfo.year.metadata.bsc)
          ? searchInfo.year.metadata.bsc
          : [searchInfo.year.metadata.bsc]
        : undefined,
      setName: searchInfo.set?.metadata?.bsc
        ? Array.isArray(searchInfo.set.metadata.bsc)
          ? searchInfo.set.metadata.bsc
          : [searchInfo.set.metadata.bsc]
        : undefined,
      variant: searchInfo.variantType?.metadata?.bsc
        ? Array.isArray(searchInfo.variantType.metadata.bsc)
          ? searchInfo.variantType.metadata.bsc
          : [searchInfo.variantType.metadata.bsc]
        : undefined,
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

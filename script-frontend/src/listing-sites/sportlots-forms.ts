import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';
import chalk from 'chalk';
import { useSpinners } from '../utils/spinners';
import { ask } from '../utils/ask';
import { type Category, type SetInfo } from '../models/setInfo';

const { showSpinner, log } = useSpinners('sportlots-forms', chalk.blueBright);

const BASE_URL = 'https://www.sportlots.com/';

let httpClient: AxiosInstance | undefined;
let cookieJar: CookieJar | undefined;

function getHttpClient(): AxiosInstance {
  if (!httpClient) {
    cookieJar = new CookieJar();
    httpClient = wrapper(
      axios.create({
        baseURL: BASE_URL,
        withCredentials: true,
        // Provide the cookie jar to persist session
        jar: cookieJar,
        // Set a fairly standard browser-like header set to avoid being blocked by basic filters
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // Axios in Node follows redirects via follow-redirects
        maxRedirects: 10,
        validateStatus: (status) => status >= 200 && status < 400, // allow redirects
      }),
    );
  }
  return httpClient;
}

function toAbsoluteUrl(relativeOrAbsolute: string): string {
  try {
    const url = new URL(relativeOrAbsolute, BASE_URL);
    return url.toString();
  } catch {
    return relativeOrAbsolute;
  }
}

async function login(): Promise<void> {
  const { update, finish, error } = showSpinner('login', 'Login');
  try {
    const client = getHttpClient();
    update('Opening session');

    // First hit the login page to establish initial cookies
    await client.get('cust/custbin/login.tpl?urlval=/index.tpl&qs=');

    update('Submitting credentials');
    const form = new URLSearchParams();
    form.set('email_val', process.env.SPORTLOTS_ID as string);
    form.set('psswd', process.env.SPORTLOTS_PASS as string);
    // Some backends expect the submit value; harmless if ignored
    form.set('Sign-in', 'Sign-in');

    await client.post('cust/custbin/login.tpl?urlval=/index.tpl&qs=', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    finish();
  } catch (e) {
    error(e);
    throw e;
  }
}

async function ensureLoggedIn(): Promise<void> {
  if (!httpClient) {
    await login();
    return;
  }
  // Best-effort: if we do not have any cookies yet, log in
  const cookies = await cookieJar!.getCookies(BASE_URL);
  if (!cookies || cookies.length === 0) {
    await login();
  }
}

type SelectOption = {
  key: string;
  name: string;
};

function parseSelectOptions(html: string, selectName: string): SelectOption[] {
  const $ = load(html);
  const options: SelectOption[] = [];
  $(`select[name="${selectName}"] option`).each((_, el) => {
    const name = $(el).text().trim();
    const key = $(el).attr('value')?.trim() || '';
    if (key) options.push({ key, name });
  });
  return options;
}

async function loadAddInventoryScreen(
  year: string,
  brand: string,
  sport: string,
  bin?: string,
): Promise<string> {
  const { update } = showSpinner('loadAddInventory', 'Load Add Inventory');
  await ensureLoggedIn();
  const client = getHttpClient();

  // Retrieve the form to capture dynamic action/hidden fields
  const getResp = await client.get('inven/dealbin/newinven.tpl');
  const $ = load(getResp.data);
  const formEl = $('form').first();
  const action = toAbsoluteUrl(formEl.attr('action') || 'inven/dealbin/newinven.tpl');

  const fields = new URLSearchParams();

  // include hidden inputs
  formEl.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    const value = $(el).attr('value') || '';
    if (name) fields.append(name, value);
  });

  // Set selects/inputs the user would have chosen
  fields.set('yr', year);
  fields.set('brd', brand);
  fields.set('sprt', sport);
  if (bin) fields.set('dbin', bin);

  // Emulate clicking Next if the button has a name; otherwise omit
  const nextBtn = formEl.find('input[type="submit"][value="Next"],button[type="submit"]:contains("Next")').first();
  const nextName = nextBtn.attr('name');
  if (nextName) fields.set(nextName, nextBtn.attr('value') || 'Next');

  update('Submitting Add Inventory form');
  const postResp = await client.post(action, fields.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return postResp.data as string; // sets list page HTML
}

function parseSets(html: string): { name: string; value: string }[] {
  const $ = load(html);
  const results: { name: string; value: string }[] = [];

  // Prefer parsing the radio list for set selection
  const form = $('form').filter((_, f) => $(f).find('input[name="selset"]').length > 0).first();
  if (form.length) {
    form.find('input[name="selset"]').each((_, el) => {
      const value = $(el).attr('value')?.trim();
      if (!value) return;
      // The label/text is typically adjacent; try siblings/parent row
      const row = $(el).closest('tr');
      let name = row.find('td').last().text().trim();
      if (!name) {
        // Fallback: concatenate all text after the input
        name = $(el).parent().text().replace(/\s+/g, ' ').trim();
      }
      results.push({ name, value });
    });
  } else {
    // Fallback to the simpler text split strategy used before
    const header = $('th').filter((_, th) => /Set\s*Name/i.test($(th).text())).first();
    if (header.length) {
      const table = header.closest('table');
      const text = table.text();
      text
        .split('\n')
        .map((row) => row.trim())
        .filter(Boolean)
        .forEach((row) => {
          const spaceIdx = row.indexOf(' ');
          if (spaceIdx > 0) {
            const value = row.substring(0, spaceIdx);
            const name = row.substring(spaceIdx + 1);
            if (/^\d+$/.test(value)) results.push({ name, value });
          }
        });
    }
  }
  return results;
}

async function submitSetSelection(setsPageHtml: string, setId: string): Promise<string> {
  await ensureLoggedIn();
  const client = getHttpClient();
  const $ = load(setsPageHtml);
  const form = $('form').filter((_, f) => $(f).find('input[name="selset"]').length > 0).first();
  const action = toAbsoluteUrl(form.attr('action') || '');

  const fields = new URLSearchParams();

  // include hidden inputs
  form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    const value = $(el).attr('value') || '';
    if (name) fields.append(name, value);
  });

  // Selected set
  fields.set('selset', setId);

  // Prefer submitting the specific Get Cards button if present
  const getBtn = form.find('input[type="submit"][value="Get Cards"],button[type="submit"]:contains("Get Cards")').first();
  const btnName = getBtn.attr('name');
  if (btnName) fields.set(btnName, getBtn.attr('value') || 'Get Cards');

  const postResp = await client.post(action || BASE_URL, fields.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return postResp.data as string; // cards list HTML
}

function parseCards(html: string): { cardNumber: string; title: string }[] {
  const $ = cheerio.load(html);
  const cards: { cardNumber: string; title: string }[] = [];

  // Target rows with at least 3 td's and not headers
  $('form table tr').each((_, tr) => {
    const row = $(tr);
    if (row.find('th').length > 0) return;
    const tds = row.find('td');
    if (tds.length < 3) return;
    const cardNumber = $(tds.get(1)).text().trim();
    const title = $(tds.get(2)).text().trim();
    if (cardNumber && title) {
      cards.push({ cardNumber, title });
    }
  });

  return cards;
}

export async function getSLCards(
  setInfo: SetInfo & {
    year: Category;
    brand: Category;
    sport: Category;
  },
  category: Category,
  expectedCards: number,
): Promise<{ cardNumber: string; title: string }[]> {
  const cards: { cardNumber: string; title: string }[] = [];
  const { finish, error } = showSpinner('getSLCards', 'Get Cards');
  try {
    await ensureLoggedIn();

    const setsPageHtml = await loadAddInventoryScreen(
      setInfo.year.metadata?.sportlots,
      setInfo.brand.metadata?.sportlots,
      setInfo.sport.metadata?.sportlots,
      category.metadata?.sportlots,
    );

    const cardsPageHtml = await submitSetSelection(setsPageHtml, category.metadata?.sportlots);

    const parsed = parseCards(cardsPageHtml);
    if (parsed.length === 0) {
      log('No cards found on SportLots');
    }
    cards.push(...parsed);
    finish();
  } catch (e) {
    error(e);
  }
  return cards;
}

const getOptions = async (
  defaultName: string | undefined,
  selectName: string,
  displayName: string,
): Promise<SelectOption | undefined> => {
  await ensureLoggedIn();
  const client = getHttpClient();
  const html = (await client.get('inven/dealbin/newinven.tpl')).data as string;
  const values = parseSelectOptions(html, selectName).map((opt) => ({ name: opt.name, value: opt }));

  values.push({ name: 'None', value: { name: 'None', key: 'N/A' } });

  const selected = await ask(`SportLots ${displayName}`, defaultName, { selectOptions: values });
  return selected.name === 'None' ? undefined : (selected as unknown as SelectOption);
};

export const getSLSport = async (defaultName?: string): Promise<SelectOption | undefined> =>
  getOptions(defaultName, 'sprt', 'Sport');
export const getSLYear = async (defaultName?: string): Promise<SelectOption | undefined> =>
  defaultName ? { name: defaultName, key: defaultName } : getOptions(defaultName, 'yr', 'Year');
export const getSLBrand = async (defaultName?: string): Promise<SelectOption | undefined> =>
  getOptions(defaultName, 'brd', 'Brand');

export async function getSLSet(setInfo: SetInfo): Promise<SelectOption | undefined> {
  const { finish, error } = showSpinner('getSLSet', 'Finding Set');
  try {
    if (!setInfo.year.metadata) throw new Error('Set Info (Year) Metadata not found');
    if (!setInfo.brand.metadata) throw new Error('Set Info (Brand) Metadata not found');
    if (!setInfo.sport.metadata) throw new Error('Set Info (Sport) Metadata not');

    const setsPageHtml = await loadAddInventoryScreen(
      setInfo.year.metadata.sportlots,
      setInfo.brand.metadata.sportlots,
      setInfo.sport.metadata.sportlots,
    );

    const allSets = parseSets(setsPageHtml);
    allSets.push({ name: 'None', value: 'None' });

    let defaultAnswer = `${setInfo.brand.name} ${setInfo.set.name}`;
    if (setInfo.variantName) {
      defaultAnswer = `${defaultAnswer} ${setInfo.variantName.name}`;
    }
    const selected = await ask('SportLots Set', defaultAnswer, { selectOptions: allSets });
    finish();
    return selected && (selected as unknown as SelectOption).value !== 'None'
      ? (selected as unknown as SelectOption)
      : undefined;
  } catch (e) {
    error(e);
    throw e;
  }
}

export async function shutdownSportLotsForms(): Promise<void> {
  const { finish, error } = showSpinner('shutdown', 'Shutting down SportLots Forms');
  try {
    httpClient = undefined;
    cookieJar = undefined;
    finish('Sportlots Forms shutdown complete');
  } catch (e) {
    error('Sportslots Forms shutdown errored');
  }
}



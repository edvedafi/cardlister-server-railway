import { remote } from 'webdriverio';
import chalk from 'chalk';
import { useSpinners } from '../utils/spinners';
import { ask } from '../utils/ask';
import { type Category, type SetInfo } from '../models/setInfo';

const { showSpinner, log } = useSpinners('sportlots', chalk.blueBright);

let _browser: WebdriverIO.Browser;

async function login() {
  if (!_browser) {
    const { update, error, finish } = showSpinner('login', 'Login');
    update('Opening Browser');
    try {
      _browser = await remote({
        capabilities: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            args: ['headless', 'disable-gpu'],
          },
        },
        baseUrl: 'https://www.sportlots.com/',
        logLevel: 'error',
      });

      update('Logging in');
      await _browser.url('cust/custbin/login.tpl?urlval=/index.tpl&qs=');
      await _browser.$('input[name="email_val"]').setValue(process.env.SPORTLOTS_ID as string);
      await _browser.$('input[name="psswd"]').setValue(process.env.SPORTLOTS_PASS as string);
      await _browser.$('input[value="Sign-in"]').click();
      finish();
    } catch (e) {
      error(e);
    }
  }
  return _browser;
}

async function loadAddInventoryScreen(year: string, brand: string, sport: string, bin?: string): Promise<void> {
  try {
    const browser = await login();
    await browser.url('https://www.sportlots.com/inven/dealbin/newinven.tpl');
    await browser.$('select[name="yr"]').selectByAttribute('value', year);
    await browser.$('select[name="brd"]').selectByAttribute('value', brand);
    await browser.$('select[name="sprt"]').selectByAttribute(
      'value',
      {
        baseball: 'BB',
        football: 'FB',
        basketball: 'BK',
      }[sport.toLowerCase()] || sport,
    );
    if (bin) {
      await browser.$('input[name="dbin"').setValue(bin);
    }
    await browser.$('aria/Default to new pricing').click();
    await browser.$('input[value="Next"').click();
  } catch (e) {
    console.error(e);
    log(`Error Loading Inventory Screen for ${year} - ${brand} - ${sport} - ${bin}`);
    throw e;
  }
}

async function selectSet(setId: string): Promise<void> {
  const browser = await login();
  await browser.waitUntil(async () => (await browser.getUrl()).match(/dealsets.tpl/));
  await browser.$(`input[name="selset"][value="${setId}"]`).click();
  await browser.$('input[value="Get Cards"').click();
}

export async function getSLCards(
  setInfo: SetInfo & {
    year: Category;
    brand: Category;
    sport: Category;
  },
  category: Category,
): Promise<{ cardNumber: string; title: string }[]> {
  const cards = [];
  const { finish, error } = showSpinner('getSLCards', 'Get Cards');
  try {
    const browser = await login();
    await loadAddInventoryScreen(
      setInfo.year.metadata?.sportlots,
      setInfo.brand.metadata?.sportlots,
      setInfo.sport.metadata?.sportlots,
      category.metadata?.sportlots,
    );

    await selectSet(category.metadata?.sportlots);

    while ((await browser.getUrl()).includes('listcards.tpl')) {
      const rows = await browser
        .$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody')
        .$$('tr:has(td):not(:has(th))');
      for (const row of rows) {
        cards.push({
          cardNumber: await row.$('td:nth-child(2)').getText(),
          title: await row.$('td:nth-child(3)').getText(),
        });
      }
      if (cards.length === 0) {
        await browser.saveScreenshot('sportlots-error.png');
        await $`open sportlots-error.png`;
        throw new Error('No cards found on SportLots');
      }
      await browser.$('input[value="Inventory Cards"').click();
    }
    finish();
  } catch (e) {
    error(e);
  }
  return cards;
}

type SelectOption = {
  key: string;
  name: string;
};
const getOptions = async (
  defaultName: string | undefined,
  selectName: string,
  displayName: string,
): Promise<SelectOption> => {
  const browser = await login();
  await browser.url(`inven/dealbin/newinven.tpl`);
  const options = await browser.$(`select[name="${selectName}"]`).$$('option');
  const values: { value: SelectOption; name: string }[] = [];
  for (const option of options) {
    values.push({
      name: await option.getText(),
      value: {
        name: await option.getText(),
        key: await option.getAttribute('value'),
      },
    });
  }
  return await ask(`SportLots ${displayName}`, defaultName, { selectOptions: values });
};

export const getSLSport = async (defaultName?: string): Promise<SelectOption> =>
  getOptions(defaultName, 'sprt', 'Sport');
export const getSLYear = async (defaultName?: string): Promise<SelectOption> =>
  defaultName ? { name: defaultName, key: defaultName } : getOptions(defaultName, 'yr', 'Year');
export const getSLBrand = async (defaultName?: string): Promise<SelectOption> =>
  getOptions(defaultName, 'brd', 'Brand');

export async function getSLSet(setInfo: SetInfo): Promise<SelectOption> {
  const { finish, error } = showSpinner('getSLSet', 'Finding Set');
  try {
    const browser = await login();

    if (!setInfo.year.metadata) throw new Error('Set Info (Year) Metadata not found');
    if (!setInfo.brand.metadata) throw new Error('Set Info (Brand) Metadata not found');
    if (!setInfo.sport.metadata) throw new Error('Set Info (Sport) Metadata not');

    await loadAddInventoryScreen(
      setInfo.year.metadata.sportlots,
      setInfo.brand.metadata.sportlots,
      setInfo.sport.metadata.sportlots,
    );

    //find the table and iterate through the rows
    const allSets = [];
    const table = await browser.$('th=Set Name');
    await table.waitForDisplayed({ timeout: 5000 });
    const rows = await table.$('../..').$$('tr:has(td):not(:has(th))');
    for (const row of rows) {
      const columns = await row.$$('td');
      if (columns.length > 1) {
        const fullSetText = await columns[1].getText();
        const setNumber = fullSetText.substring(0, fullSetText.indexOf(' '));
        const setText = fullSetText.substring(fullSetText.indexOf(' ') + 1);
        allSets.push({ name: setText, value: setNumber });
      }
    }

    let defaultAnswer = `${setInfo.brand.name} ${setInfo.set.name}`;
    if (setInfo.variantName) {
      defaultAnswer = `${defaultAnswer} ${setInfo.variantName.name}`;
    }
    const selected = await ask('SportLots Set', defaultAnswer, { selectOptions: allSets });
    finish();
    return selected;
  } catch (e) {
    error(e);
    throw e;
  }
}

export async function shutdownSportLots() {
  const { finish, error } = showSpinner('shutdown', 'Shutting down SportLots');
  if (_browser) {
    try {
      await _browser.shutdown();
      finish('Sportlots shutdown complete');
    } catch (e) {
      error('Sportslots shutdown errored');
    }
  } else {
    finish();
  }
}

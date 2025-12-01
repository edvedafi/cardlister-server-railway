import { remote } from 'webdriverio';
import chalk from 'chalk';
import { useSpinners } from '../utils/spinners';
import { ask } from '../utils/ask';
import { type Category, type SetInfo } from '../models/setInfo';
import { getBrowserlessConfig } from '../utils/browserless';

const { showSpinner, log } = useSpinners('sportlots', chalk.blueBright);

let _browser: WebdriverIO.Browser | undefined;

async function login() {
  if (!_browser) {
    const { update, error, finish } = showSpinner('login', 'Login');
    update('Opening Browser');
    try {
      // _browser = await remote({
      //   capabilities: {
      //     browserName: 'chrome',
      //     'goog:chromeOptions': {
      //       args: ['headless', 'disable-gpu'],
      //     },
      //     browserVersion: '126',
      //   },
      //   baseUrl: 'https://www.sportlots.com/',
      //   logLevel: 'error',
      // });

      _browser = await remote(getBrowserlessConfig('https://www.sportlots.com/', 'SPORTLOTS_LOG_LEVEL'));

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
  expectedCards: number,
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

    // Calculate expected number of pages
    const expectedPages = Math.ceil(expectedCards / 100);
    log(`Expected ${expectedCards} cards across ${expectedPages} pages`);
    
    // Retry logic for loading the page with proper pagination
    // Only retry on technical errors (page won't load, pagination broken)
    // Don't retry if we successfully get cards but count is less than expected
    let retryCount = 0;
    const maxRetries = 3;
    let pageLoaded = false;
    
    while (retryCount < maxRetries && !pageLoaded) {
      if (retryCount > 0) {
        log(`Retry attempt ${retryCount}/${maxRetries} - reloading inventory screen`);
        await loadAddInventoryScreen(
          setInfo.year.metadata?.sportlots,
          setInfo.brand.metadata?.sportlots,
          setInfo.sport.metadata?.sportlots,
          category.metadata?.sportlots,
        );
        log(`Selected set: ${category.metadata?.sportlots}`);
        await selectSet(category.metadata?.sportlots);
      }
      
      try {
        // Wait for navigation to listcards.tpl page
        log('Waiting for navigation to cards page...');
        await browser.waitUntil(async () => {
          const url = await browser.getUrl();
          log(`Current URL: ${url}`);
          return url.includes('listcards.tpl');
        }, { timeout: 10000 });
        
        log(`URL after navigation: ${await browser.getUrl()}`);
        
        // Wait for the table to load
        await browser.waitUntil(async () => {
          try {
            const table = await browser.$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody');
            await table.waitForDisplayed({ timeout: 2000 });
            const rows = await table.$$('tr:has(td):not(:has(th))');
            return rows.length > 0;
          } catch {
            return false;
          }
        }, { timeout: 10000 });
        
        const rows = await browser.$$('tr:has(td):not(:has(th))');
        log(`Found ${rows.length} card rows in table`);
        
        // If we have rows, the page loaded successfully
        // Don't check pagination completeness here - that's a data issue, not a technical error
        // We'll collect all available cards and return them even if count < expected
        if (rows.length > 0) {
          pageLoaded = true;
          log('Page loaded successfully - will collect all available cards');
        } else {
          // No rows found - this is a technical error, retry
          log('No rows found on page, retrying...');
          retryCount++;
          if (retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      } catch (e) {
        // Technical error during page load - retry
        log(`Technical error loading page: ${e}`);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          throw e; // Re-throw if all retries exhausted
        }
      }
    }
    
    if (!pageLoaded) {
      throw new Error(`Failed to load page after ${maxRetries} attempts`);
    }
    
    // Collect cards from all pages
    // Continue pagination if available, but return what we have even if count < expected
    while ((await browser.getUrl()).includes('listcards.tpl')) {
      const rows = await browser
        .$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody')
        .$$('tr:has(td):not(:has(th))');
      for (const row of rows) {
        try {
          const card = {
            cardNumber: await row.$('td:nth-child(2)').getText(),
            title: await row.$('td:nth-child(3)').getText(),
          };

          cards.push(card);
        } catch(e) {
          log(e);
          log(`Error getting card number and title for row: ${await row.getText()}`)
        }
      }
      
      // Only throw if we have NO cards at all (technical failure)
      // If we have some cards but fewer than expected, that's a data issue - return what we have
      if (cards.length === 0 && !(await browser.getUrl()).includes('listcards.tpl')) {
        await browser.saveScreenshot('sportlots-error.png');
        await $`open sportlots-error.png`;
        throw new Error('No cards found on SportLots');
      }
      
      // Get current page number from URL
      const currentUrl = await browser.getUrl();
      const currentPageMatch = currentUrl.match(/start=(\d+)/);
      const currentPage = currentPageMatch ? Math.floor(parseInt(currentPageMatch[1]) / 100) + 1 : 1;
      log(`Current page: ${currentPage}, collected ${cards.length} cards so far`);
      
      // Try to find and navigate to next page if available
      const paginationLinks = await browser.$$(`a[href*="listcards.tpl"]`);
      const nextPageNumber = currentPage + 1;
      let nextPageLink = null;
      
      // Look through all pagination links to find the one with the correct page number
      for (const link of paginationLinks) {
        const linkText = await link.getText();
        if (linkText.trim() === nextPageNumber.toString()) {
          nextPageLink = link;
          break;
        }
      }
      
      if (nextPageLink) {
        // Next page exists, navigate to it
        log(`Found page ${nextPageNumber} link, navigating...`);
        await nextPageLink.click();
        
        // Wait for the page to load
        await browser.waitUntil(async () => {
          const newUrl = await browser.getUrl();
          const newPageMatch = newUrl.match(/start=(\d+)/);
          const newPage = newPageMatch ? Math.floor(parseInt(newPageMatch[1]) / 100) + 1 : 1;
          return newPage === nextPageNumber;
        }, { timeout: 10000 });
        
        // Wait for the page content to finish loading
        await browser.waitUntil(async () => {
          try {
            const table = await browser.$('body > div > table:nth-child(2) > tbody > tr > td > form > table > tbody');
            await table.waitForDisplayed({ timeout: 2000 });
            const rows = await table.$$('tr:has(td):not(:has(th))');
            return rows.length > 0;
          } catch (e) {
            return false;
          }
        }, { timeout: 10000 });
        log(`Successfully navigated to page ${nextPageNumber}`);
      } else {
        // No more pages available - return what we have
        log(`No more pages available. Collected ${cards.length} cards (expected ${expectedCards})`);
        break;
      }
    }
    
    // Log final count comparison but don't throw - let caller handle insufficient cards
    if (cards.length < expectedCards) {
      log(`Retrieved ${cards.length} cards, expected ${expectedCards}. Returning available cards for caller to handle.`);
    } else {
      log(`Retrieved ${cards.length} cards, expected ${expectedCards}.`);
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
): Promise<SelectOption | undefined> => {
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

  values.push({
    name: 'None',
    value: {
      name: 'None',
      key: 'N/A',
    },
  });
  const selected = await ask(`SportLots ${displayName}`, defaultName, { selectOptions: values });
  return selected.name === 'None' ? undefined : selected;
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
    const table = await browser.$('th=Set Name');
    await table.waitForDisplayed({ timeout: 5000 });
    const tableText = await table.$('../..').getText();
    //split the text into rows
    const allSets = tableText.split('\n').map((row) => {
      const setNumber = row.substring(0, row.indexOf(' '));
      const setText = row.substring(row.indexOf(' ') + 1);
      return { name: setText, value: setNumber };
    });

    allSets.push({ name: 'None', value: 'None' });

    let defaultAnswer = `${setInfo.brand.name} ${setInfo.set.name}`;
    if (setInfo.variantName) {
      defaultAnswer = `${defaultAnswer} ${setInfo.variantName.name}`;
    }
    const selected = await ask('SportLots Set', defaultAnswer, { selectOptions: allSets });
    finish();
    return 'None' === selected ? undefined : selected;
  } catch (e) {
    error(e);
    throw e;
  }
}

export async function shutdownSportLots() {
  const { finish, error } = showSpinner('shutdown', 'Shutting down SportLots');
  if (_browser) {
    try {
      await _browser.deleteSession();
      _browser = undefined; // Reset browser so it will be recreated on next login
      finish('Sportlots shutdown complete');
    } catch (e) {
      error('Sportslots shutdown errored');
      _browser = undefined; // Reset even on error
    }
  } else {
    finish();
  }
}




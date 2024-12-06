import { configDotenv } from 'dotenv';
import 'zx/globals';
import initializeFirebase from './utils/firebase.js';
import { shutdownSportLots } from './listing-sites/sportlots.js';
import chalk from 'chalk';
import { useSpinners } from './utils/spinners.js';
import { onShutdown } from 'node-graceful-shutdown';
import { findSet } from './card-data/setData';
import { getFiles, getInputs } from './utils/inputs';
import { parseArgs } from './utils/parseArgs';
import terminalImage from 'terminal-image';
import { processSet } from './card-data/listSet';
import type { ProductCategory } from '@medusajs/client-types';
import { getCategory } from './utils/medusa';
import type { SetInfo } from './models/setInfo';

configDotenv();

$.verbose = false;

const shutdown = async () => {
  await Promise.all([shutdownSportLots()]);
};

onShutdown(shutdown);

const { showSpinner, log } = useSpinners('addCards', chalk.cyan);

const { update, finish, error } = showSpinner('addCards', 'Adding Cards');

try {
  update('Logging in');
  initializeFirebase();

  // Set up full run information
  update('Gathering Inputs');
  const args = parseArgs(
    {
      boolean: ['s', 'b', 'u', 'z', 'c', 'a', 'i', 'v', 'o'],
      string: ['n'],
      alias: {
        s: 'select-bulk-cards',
        b: 'bulk',
        n: 'numbers',
        u: 'skipSafetyCheck',
        z: 'lastZipFile',
        c: 'countCardsFirst',
        a: 'allBase',
        i: 'images',
        v: 'inventory',
        o: 'no-sync',
      },
    },
    {
      s: 'Select Bulk Cards',
      b: 'Bulk Only Run',
      n: 'Card Numbers to enter quantity \n        ex: --numbers="1,2,3,4,5"\n        ex: --numbers="1-5" \n        ex: --numbers=">5"\n        ex: --numbers="<5"',
      u: 'Skip Safety Check',
      z: 'Process the most recent zip file in the users Downloads directory',
      c: 'Enter Counts of cards first and then process the zip file of images',
      a: 'All Cards are base pricing so skip the pricing questions',
      i: 'Attempt to use the image as is first',
      v: 'Inventory Mode: Will only show cards with a quantity greater than 0',
      o: 'No Sync run after updating',
    },
  );

  if (args['numbers'] || args['select-bulk-cards'] || args['inventory']) {
    args['bulk'] = true;
  }

  const input_directory = args['bulk'] || args['countCardsFirst'] ? 'input/bulk' : await getInputs(args);

  //gather the list of files that we will process
  let files: string[] = [];
  if (input_directory !== 'input/bulk/') {
    files = await getFiles(input_directory);
  }

  update('Gathering Set Data');
  if (files && files[0]) {
    log('  ' + (await terminalImage.file(files[0], { height: 25 })));
  }
  const setData = await findSet({ allowParent: args['inventory'], parentName: 'All' });
  update('Processing Singles');
  // log(setData);
  if (setData.category && setData.category.category_children.length === 0) {
    await processSet(setData, files, args);
  } else {
    const processChildren = async (productCategory: ProductCategory, data: SetInfo) => {
      const categories = productCategory.category_children.sort((a, b) =>
        a.name?.indexOf('Retail') > -1 ? 1 : b.name?.indexOf('Retail') > 1 ? -1 : a.name.localeCompare(b.name),
      );
      for (const category of categories) {
        update(`Processing ${category.name}`);
        log(`Processing ${category.name}`);
        await processSet({ ...data, category, metadata: category.metadata }, files, args);
      }
    };
    const processCategory = async (category: ProductCategory, child: string, data: SetInfo) => {
      let toProcess = child ? category.category_children.find((c) => c.name === child) : category;
      if (!toProcess) return;
      if (!toProcess.category_children?.length) {
        toProcess = await getCategory(toProcess.id);
      }
      if (toProcess.category_children?.length) {
        await processChildren(toProcess, data);
      } else {
        await processSet({ ...data, category: toProcess, metadata: toProcess.metadata }, files, args);
      }
    };
    const processSetData = async (set: ProductCategory, data: SetInfo) => {
      if (!set.category_children) {
        set = await getCategory(set.id);
      }
      data.set = set;
      await processCategory(set, 'Base', data);
      await processCategory(set, 'Parallel', data);
      await processCategory(set, 'Insert', data);
    };
    const processBrandData = async (brand: ProductCategory, data: SetInfo) => {
      if (!brand.category_children) {
        brand = await getCategory(brand.id);
      }
      data.brand = brand;
      for (const set of brand.category_children) {
        await processSetData(set, data);
      }
    };
    const processYear = async (year: ProductCategory, data: SetInfo) => {
      if (!year.category_children) {
        year = await getCategory(year.id);
      }
      data.year = year;
      for (const brand of year.category_children) {
        await processBrandData(brand, data);
      }
    };
    const processSport = async (sport: ProductCategory, data: SetInfo) => {
      if (!sport.category_children) {
        sport = await getCategory(sport.id);
      }
      data.sport = sport;
      for (const year of sport.category_children) {
        await processYear(year, data);
      }
    };
    if (setData.variantType) {
      log(setData.variantType);
      await processChildren(setData.variantType, setData);
    } else if (setData.set) {
      await processSetData(setData.set, setData);
    } else if (setData.brand) {
      await processBrandData(setData.brand, setData);
    } else if (setData.sport) {
      await processSport(setData.sport, setData);
    } else if (setData.year) {
      await processYear(setData.year, setData);
    } else {
      throw new Error('No category found');
    }
  }
  // if (setData.set) {
  //
  //   await processSet(setData, files, args);
  // } else {
  //   update('Processing Inventory');
  //
  //   if (setData.variantType) {
  //     // await processSet(setData, files, args);
  //   }
  // }
} catch (e) {
  error(e);
} finally {
  await shutdown();
  finish('Completed Processing');
}

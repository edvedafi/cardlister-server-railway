import { configDotenv } from 'dotenv';
import 'zx/globals';
import initializeFirebase from './utils/firebase.js';
import { shutdownSportLots, setSportlotsImplementation } from './listing-sites/sportlots-adapter.js';
import chalk from 'chalk';
import { useSpinners } from './utils/spinners.js';
import { onShutdown } from 'node-graceful-shutdown';
import { findSet } from './card-data/setData';
import { getFiles, getInputs } from './utils/inputs';
import { parseArgs } from './utils/parseArgs';
import terminalImage from 'term-img';
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
      string: ['n', 'sl', 'p'],
      alias: {
        s: 'select-bulk-cards',
        b: 'bulk',
        n: 'numbers',
        sl: 'sportlots-impl',
        u: 'skipSafetyCheck',
        z: 'lastZipFile',
        c: 'countCardsFirst',
        a: 'allBase',
        i: 'images',
        v: 'inventory',
        o: 'no-sync',
        p: 'price',
      },
    },
    {
      s: 'Select Bulk Cards',
      b: 'Bulk Only Run',
      n: 'Card Numbers to enter quantity \n        ex: --numbers="1,2,3,4,5"\n        ex: --numbers="1-5" \n        ex: --numbers=">5"\n        ex: --numbers="<5"',
      sl: 'SportLots implementation: webdriver or forms (default webdriver). Example: --sl=forms',
      u: 'Skip Safety Check',
      z: 'Process the most recent zip file in the users Downloads directory',
      c: 'Enter Counts of cards first and then process the zip file of images',
      a: 'All Cards are base pricing so skip the pricing questions',
      i: 'Attempt to use the image as is first',
      v: 'Inventory Mode: Will only show cards with a quantity greater than 0',
      o: 'No Sync run after updating',
      p: 'Price Mode: Update pricing and quantity for cards in a set. Optional percentage reduction (e.g., -p 10 for 10% reduction, -p for 0% reduction)',
    },
  );

  // Configure SportLots implementation before any SportLots calls
  const slImplArg = (args['sportlots-impl'] || args['sl'] || '').toString().toLowerCase();
  if (slImplArg === 'forms' || process.env.SL_IMPL === 'forms') {
    setSportlotsImplementation('forms');
  } else {
    setSportlotsImplementation('webdriver');
  }

  if (args['numbers'] || args['select-bulk-cards'] || args['inventory'] || args['price'] !== undefined) {
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
    log(` Displaying: ${files[0]}`);
    
    try {
      // Try to display the image using term-img first (for iTerm2/supported terminals)
      const imageOutput = await terminalImage(files[0], { height: 25 });
      log('  ' + imageOutput);
    } catch (error) {
      // If term-img fails, try multiple terminal image viewers for best quality
      log('  📷 [Displaying image using terminal viewers...]');
      log(`     File: ${files[0].split('/').pop()}`);
      
      try {
        // Try chafa first - it often gives the best quality
        const chafaResult = await $`chafa --size 80x25 ${files[0]}`;
        log('     🎨 High-Quality ANSI Image:');
        log(chafaResult.stdout);
        log('     ✅ Image displayed using chafa (best quality)');
        
      } catch (chafaError) {
        try {
          // Try terminalimageviewer (tiv) as second option
          const tivResult = await $`tiv -h 25 ${files[0]}`;
          log('     🖼️  Terminal Image:');
          log(tivResult.stdout);
          log('     ✅ Image displayed using terminalimageviewer');
          
        } catch (tivError) {
          try {
            // Try catimg as third option
            const catimgResult = await $`catimg -H 25 -r 2 ${files[0]}`;
            log('     🐱 Cat Image:');
            log(catimgResult.stdout);
            log('     ✅ Image displayed using catimg');
            
          } catch (catimgError) {
            // Final fallback: open in system viewer and show metadata
            log('     📷 [Opening in system viewer as final fallback...]');
            
            try {
              const sharp = await import('sharp');
              const metadata = await sharp.default(files[0]).metadata();
              log(`     Dimensions: ${metadata.width} x ${metadata.height}`);
              log(`     Format: ${metadata.format}`);
              
              await $`open ${files[0]}`;
              log('     ✅ Image opened in system viewer');
              
            } catch (systemError) {
              log('     ❌ All image display methods failed');
              log(`     📁 File exists at: ${files[0]}`);
            }
          } 
        }
      }
    }
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

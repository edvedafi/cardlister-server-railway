import { configDotenv } from 'dotenv';
import 'zx/globals';
import initializeFirebase from './utils/firebase.js';
import { shutdownSportLots } from './listing-sites/sportlots.js';
import chalk from 'chalk';
import { useSpinners } from './utils/spinners.js';
import { onShutdown } from 'node-graceful-shutdown';
import { findSet } from './card-data/setData';
import { processSet } from './card-data/listSet';
import { getFiles, getInputs } from './utils/inputs';
import { parseArgs } from './utils/parseArgs';
import terminalImage from 'terminal-image';

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
      boolean: ['s', 'b', 'c'],
      string: ['n'],
      alias: {
        s: 'select-bulk-cards',
        b: 'bulk',
        n: 'numbers',
        c: 'skipSafetyCheck',
      },
    },
    {
      s: 'Select Bulk Cards',
      b: 'Bulk Only Run',
      n: 'Card Numbers to enter quantity \n        ex: --numbers="1,2,3,4,5"\n        ex: --numbers="1-5" \n        ex: --numbers=">5"\n        ex: --numbers="<5"',
      c: 'Skip Safety Check',
    },
  );

  if (args['numbers'] || args['select-bulk-cards']) {
    args['bulk'] = true;
  }

  const input_directory = args['bulk'] ? 'input/bulk' : await getInputs(args);

  //gather the list of files that we will process
  let files: string[] = [];
  if (input_directory !== 'input/bulk/') {
    files = await getFiles(input_directory);
  }

  update('Gathering Set Data');
  if (files && files[0]) {
    log('  ' + (await terminalImage.file(files[0], { height: 25 })));
  }
  const setData = await findSet();

  update('Processing Singles');
  await processSet(setData, files, args);
} catch (e) {
  error(e);
} finally {
  await shutdown();
  finish('Completed Processing');
}

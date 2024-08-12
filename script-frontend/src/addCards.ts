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
import minimist from "minimist";

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
  const args = minimist(process.argv.slice(2));
  const input_directory = await getInputs(args);

  update('Gathering Set Data');
  const setData = await findSet();

  //gather the list of files that we will process
  let files: string[] = [];
  if (input_directory !== 'input/bulk/') {
    files = await getFiles(input_directory);
  }

  update('Processing Singles');
  await processSet(setData, files);
} catch (e) {
  error(e);
} finally {
  await shutdown();
  finish('Completed Processing');
}

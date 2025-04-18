import { getFiles, getInputs } from './src/utils/inputs';
import 'zx/globals';
import { ChatGPTProcessor } from './src/image-processing/chatgpt-processor';
import { parseArgs } from './src/utils/parseArgs';
import { useSpinners } from './src/utils/spinners';
import initializeFirebase from './src/utils/firebase';
import dotenv from 'dotenv';

dotenv.config();

const { showSpinner, log } = useSpinners('chatGPT', chalk.cyan);

async function main() {

  const { update, finish, error } = showSpinner('chatGPT', 'Processing Cards');
  try {
    update('Initializing');
    initializeFirebase();

    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Please set OPENAI_API_KEY in your .env file');
    }

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

    // Gather the list of files that we will process
    let files: string[] = [];
    if (input_directory !== 'input/bulk/') {
      files = await getFiles(input_directory);
    }

    if (files.length === 0) {
      error('No files found to process');
      return;
    }

    // Initialize ChatGPT processor
    const chatGPTProcessor = new ChatGPTProcessor(process.env.OPENAI_API_KEY);

    // Process each file with ChatGPT
    update('Processing images with ChatGPT');
    const results = await chatGPTProcessor.processImages(files);

    // Log results
    finish('Processing complete');
    console.log('Processing results:', results);

  } catch (err) {
    error(err);
  }
}

main().catch((error) => {
  console.error('Error in main:', error);
  process.exit(1);
});

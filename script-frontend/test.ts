import { getFiles, getInputs } from './src/utils/inputs';
import 'zx/globals';
import { ChatGPTProcessor } from './src/image-processing/chatgpt-processor';
import { cropCardsWithPython, orientAndClassifyCards, orderFrontBack } from './src/image-processing/card-cropper-wrapper';
import { cropImage } from './src/image-processing/imageProcessor.js';
import { parseArgs } from './src/utils/parseArgs';
import { useSpinners } from './src/utils/spinners';
import initializeFirebase from './src/utils/firebase';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import type { ParsedArgs } from 'minimist';

dotenv.config();

const { showSpinner, log } = useSpinners('chatGPT', chalk.cyan);

async function testOrient() {
  const args = parseArgs(
    { boolean: ['o'], alias: { o: 'orient' } },
    { o: 'Test orientation and front/back detection' },
  );

  const inputDir = args._[0] || 'input';
  const files = await getFiles(inputDir);
  if (files.length < 2) {
    console.log('Need at least 2 images for orient test');
    process.exit(1);
  }

  const imgA = files[0];
  const imgB = files[1];
  console.log(`\nImage A: ${path.basename(imgA)}`);
  console.log(`Image B: ${path.basename(imgB)}`);

  console.log('\nRunning orientation correction + text detection...\n');
  const orientResults = await orientAndClassifyCards([imgA, imgB]);

  const resultA = orientResults.get(imgA);
  const resultB = orientResults.get(imgB);

  const formatResult = (name: string, r: typeof resultA) => {
    if (!r) return `  ${name}: (no data)`;
    const rotated = r.rotation_applied !== 0 ? `rotated ${r.rotation_applied}°` : 'no rotation';
    return `  ${name}: ${r.text_detection_count} text detections, ${rotated}`;
  };

  console.log(formatResult(path.basename(imgA), resultA));
  console.log(formatResult(path.basename(imgB), resultB));

  const [front, back] = orientResults.size > 0
    ? orderFrontBack(imgA, imgB, orientResults)
    : [imgA, imgB];

  const swapped = front !== imgA;
  console.log(`\nResult:`);
  console.log(`  Front: ${path.basename(front)}`);
  console.log(`  Back:  ${path.basename(back)}`);
  if (swapped) {
    console.log(`  → Order was swapped`);
  } else {
    console.log(`  → Original order kept`);
  }

  // Display both images
  try {
    const termImg = (await import('term-img')).default;
    console.log(`\n--- FRONT: ${path.basename(front)} ---`);
    termImg(front, { width: 40, fallback: () => console.log('(cannot display image in this terminal)') });
    console.log(`\n--- BACK: ${path.basename(back)} ---`);
    termImg(back, { width: 40, fallback: () => console.log('(cannot display image in this terminal)') });
  } catch {
    console.log('\n(term-img not available for image display)');
  }
}

async function testCrop(args: ParsedArgs) {
  const inputDir = await getInputs(args);
  const files = await getFiles(inputDir, false);
  if (files.length === 0) {
    console.log('No files found in', inputDir);
    process.exit(1);
  }

  console.log(`\nFound ${files.length} file(s) in ${inputDir}`);
  console.log('Running crop pipeline on each file...\n');

  const outputDir = 'input/tmp';
  await fs.ensureDir(outputDir);

  for (const file of files) {
    const basename = path.basename(file);
    const outputFile = path.join(outputDir, `cropped-${basename}`);
    console.log(`\nCropping: ${basename}`);
    try {
      const result = await cropImage(file, null, outputDir, outputFile, true, false);
      console.log(`  -> ${result}`);
    } catch (e: any) {
      console.error(`  -> Failed: ${e.message}`);
    }
  }
}

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
        boolean: ['s', 'b', 'u', 'z', 'c', 'a', 'i', 'v', 'o', 'x', 'r'],
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
          o: 'orient',
          x: 'no-sync',
          r: 'crop',
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
        o: 'Test orientation and front/back detection',
        x: 'No Sync run after updating',
        r: 'Test cropping on all images in input directory',
      },
    );

    if (args['orient']) {
      finish('Running orient test');
      await testOrient();
      return;
    }

    if (args['crop']) {
      finish('Running crop test');
      await testCrop(args);
      return;
    }

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

    // Crop cards first using Python
    log('Cropping cards using Python');
    log('files: ', files);
    const croppedFiles = await cropCardsWithPython(files);

    // Initialize ChatGPT processor
    const chatGPTProcessor = new ChatGPTProcessor(process.env.OPENAI_API_KEY);

    // Process each cropped file with ChatGPT
    log('Processing images with ChatGPT');
    // const results = await chatGPTProcessor.processImages(croppedFiles);

    // Log results
    finish('Processing complete');
    console.log('Processing results:', croppedFiles);

  } catch (err) {
    error(err);
  }
}

main().catch((error) => {
  console.error('Error in main:', error);
  process.exit(1);
});

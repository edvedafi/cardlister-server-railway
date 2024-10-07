import dotenv from 'dotenv';
import 'zx/globals';
import { useSpinners } from './utils/spinners';
import { parseArgs } from './utils/parseArgs';
import { getFiles, getInputs } from './utils/inputs';
import { buildPDF, cropImage } from './image-processing/imageProcessor';

const args = parseArgs(
  {
    string: ['d'],
    boolean: ['c'],
    alias: {
      d: 'directory',
      c: 'clear',
    },
  },
  {
    d: 'Directory to find Files',
    c: 'Clear Output Directory',
  },
);

$.verbose = false;

dotenv.config();

const { showSpinner, log } = useSpinners('Sync', chalk.cyanBright);

const { update, finish, error } = showSpinner('top-level', 'Cropping Keeper Cards');

const directory = args['directory'] ? `input/${args.directory}/` : await getInputs(args);

const cards = await getFiles(directory, false);

const images: string[] = [];

try {
  if (args['clear']) {
    fs.rmSync('output/keepers', { recursive: true, force: true });
    fs.mkdirSync('output/keepers');
  }
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    update(`Processing ${card}`);
    const output = await cropImage(card, undefined, 'output/keepers/', `output/keepers/keepers-${i}.jpg`, false);
    log(output);
    images.push(output);
  }

  const pdf = await buildPDF(images, 'keepers.pdf');
  await $`open ${pdf}`;

  finish('Finished Cropping Keeper Cards');
} catch (e) {
  error(e);
}

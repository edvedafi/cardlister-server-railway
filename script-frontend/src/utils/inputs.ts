import { ask } from './ask.js';
import { ensureDir } from 'fs-extra';
import unzip from 'decompress';
import chalk from 'chalk';
import { useSpinners } from './spinners.js';
import {minimist} from "zx";
import ParsedArgs = minimist.ParsedArgs;

const { showSpinner, log } = useSpinners('trim', chalk.cyan);

export async function getInputs(args: ParsedArgs) {
  const {finish} = showSpinner('inputs', 'Getting Input Information');
  if (args._.length > 0) {
    const zipFile: string = args._[0];
    if (zipFile.endsWith('.zip')) {
      const zipDir = zipFile?.split('/')?.pop()?.split('.')[0].replace(/[\s()]/g, '_');
      const dir = `input/${zipDir}/`;
      await ensureDir(dir);
      await unzip(zipFile, dir);
      finish( `Input Directory: ${dir}`);
      return dir;
    } else if (zipFile.indexOf('input') > -1) {
      finish(`Input Directory: ${zipFile}`);
      return zipFile;
    } else {
      finish( `Input Directory: input/${zipFile}/`);
      return `input/${zipFile}/`;
    }
  } else {
    const input_directory = await getInputDirectory();
    finish (`Input Directory: ${input_directory}`);
    return input_directory;
  }
}

export const getInputDirectory = async () => {
  const directories = fs.readdirSync('input', { withFileTypes: true });
  const inputDirectories = ['input', 'bulk', ...directories.filter((dir) => dir.isDirectory()).map((dir) => dir.name)];
  let input_directory = await ask('Input Directory', undefined, { selectOptions: inputDirectories });
  if (input_directory === 'input') {
    input_directory = 'input/';
  } else if (input_directory === 'bulk') {
    //check to see if the bulk directory exists
    if (fs.existsSync('input/bulk')) {
      const shouldRest = await ask('Reset Bulk?', false);
      if (shouldRest) {
        //delete everything in the bulk directory
        fs.rmSync('input/bulk', { recursive: true });
        fs.mkdirSync('input/bulk');
      }
    } else {
      fs.mkdirSync('input/bulk');
    }
    input_directory = `input/bulk/`;
  } else if (input_directory.indexOf('/') !== input_directory.length - 1) {
    input_directory = `input/${input_directory}/`;
  } else {
    input_directory = `input/${input_directory}`;
  }

  return input_directory;
};

export const getFiles = async (inputDirectory :string):Promise<string[]> => {
  const {finish, error} = showSpinner('inputs', 'Getting Files');
  let files: string[] = [];
  try {
    const lsOutput = await $`ls ${inputDirectory}PXL*.jpg`;
    files = lsOutput
      .toString()
      .split('\n')
      .filter((image) => image !== '');
    finish( `Found ${files.length} Files`);
  } catch (e) {
    files = [];
    error(`No Files Found`);
  }
  return files;
};

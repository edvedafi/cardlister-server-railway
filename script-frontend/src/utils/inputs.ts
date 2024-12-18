import { ask } from './ask.js';
import { ensureDir } from 'fs-extra';
import unzip from 'decompress';
import chalk from 'chalk';
import { useSpinners } from './spinners.js';
import { minimist } from 'zx';
import ParsedArgs = minimist.ParsedArgs;

const { showSpinner } = useSpinners('trim', chalk.cyan);

export async function getInputs(args: ParsedArgs) {
  const { finish } = showSpinner('inputs', 'Getting Input Information');
  let zipFile: string | undefined = undefined;
  if (args.lastZipFile && args._.length > 0) {
    console.log('using last zip file: ' + args._[0]);
    // eslint-disable-next-line no-useless-escape
    zipFile = `/Users/jburich/Downloads/Photos-001\ \(${args._[0]}\).zip`;
  } else if (args.lastZipFile) {
    //find the most recent file in ~/Downloads
    try {
      const directory = '/Users/jburich/Downloads';
      // Read the directory contents
      const files = await fs.readdir(directory);

      // Filter for .zip files
      const zipFiles = files.filter((file) => path.extname(file).toLowerCase() === '.zip');

      if (zipFiles.length === 0) {
        throw new Error('No .zip files found in the directory');
      }

      // Map files to their stats
      const fileStats = await Promise.all(
        zipFiles.map(async (file) => {
          const filePath = path.join(directory, file);
          const stats = await fs.stat(filePath);
          return { file: filePath, mtime: stats.mtime };
        }),
      );

      // Find the file with the latest modification time
      const mostRecent = fileStats.reduce((latest, current) => (current.mtime > latest.mtime ? current : latest));
      zipFile = mostRecent.file;
    } catch (error) {
      console.error('Error:', error);
    }
  } else if (args._.length > 0) {
    console.log('using zip file: ' + args._[0]);
    zipFile = args._[0];
  }

  if (zipFile) {
    console.log('zipFile', zipFile, zipFile.endsWith('.zip'));
    if (zipFile.endsWith('.zip')) {
      console.log('got zipfile');
      const zipDir = zipFile
        ?.split('/')
        ?.pop()
        ?.split('.')[0]
        .replace(/[\s()]/g, '_');
      console.log('zipDir', zipDir);
      const dir = `input/${zipDir}/`;
      console.log('dir', dir);
      await ensureDir(dir);
      await unzip(zipFile, dir);
      finish(`Input Directory: ${dir}`);
      return dir;
    } else if (zipFile.indexOf('input') > -1) {
      console.log('got input');
      finish(`Input Directory: ${zipFile}`);
      return zipFile;
    } else {
      console.log('just a directory');
      finish(`Input Directory: input/${zipFile}/`);
      return `input/${zipFile}/`;
    }
  } else {
    const input_directory = await getInputDirectory();
    finish(`Input Directory: ${input_directory}`);
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
      const shouldRest = true; //await ask('Reset Bulk?', false);
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

export const getFiles = async (inputDirectory: string, requireEven = true): Promise<string[]> => {
  const { finish, error } = showSpinner('inputs', 'Getting Files');
  let files: string[] = [];
  try {
    const lsOutput = await $`ls ${inputDirectory}*.jpg`;
    files = lsOutput
      .toString()
      .split('\n')
      .filter((image) => image !== '');
    if (requireEven && files.length % 2 !== 0) {
      const ok = await ask(`Odd Number of Files? [${files.length}]`, false);
      if (!ok) {
        await getFiles(inputDirectory, requireEven);
      }
    }
    finish(`Found ${files.length} Files`);
  } catch (e) {
    files = [];
    error(`No Files Found`);
  }
  return files;
};

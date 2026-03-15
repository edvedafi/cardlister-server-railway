import initializeFirebase, { getStorage } from './utils/firebase.js';

const PREFIX = process.argv[2] || '';
const LIMIT = parseInt(process.argv[3] || '20');

async function listMatchingFiles(prefix: string, limit: number) {
  initializeFirebase();
  const bucket = getStorage().bucket();

  const query: { prefix?: string; maxResults: number } = { maxResults: limit };
  if (prefix) query.prefix = prefix;

  console.log(`Searching for files${prefix ? ` starting with: ${prefix}` : ' (all files)'}\n`);

  const [files] = await bucket.getFiles(query);

  if (files.length === 0) {
    console.log('No files found.');
  } else {
    console.log(`Found ${files.length} file(s):\n`);
    files.forEach((file) => console.log(file.name));
  }
}

listMatchingFiles(PREFIX, LIMIT).catch(console.error);

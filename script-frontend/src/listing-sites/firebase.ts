import type { Metadata } from '../models/setInfo';
import { useSpinners } from '../utils/spinners';
import { getFirestore, getStorage } from '../utils/firebase';
import { ask } from '../utils/ask';

const { showSpinner } = useSpinners('firebase', '#ffc107');

const _cachedGroups: { [key: string]: any } = {};

export async function getGroupByBin(bin: string) {
  const { update, finish, error } = showSpinner('getGroupByBin', `Getting group by bin ${bin}`);
  if (!_cachedGroups[bin]) {
    const db = getFirestore();
    update(`Fetching from Firebase`);
    let group;
    try {
      group = await db.collection('SalesGroups').doc(`${bin}`).get();
      _cachedGroups[bin] = group.data();
    } catch (e) {
      error(e);
    }
  }
  finish();
  return _cachedGroups[bin];
}

/**
 * Get the next number in the sequence for the given collection type
 *
 * This should be changed back to the commented out version once all the ids are consumed for performance reasons
 *
 * @param collectionType {string}  The collection type to get the next number for
 * @returns {Promise<number>} The next number in the sequence
 */
export async function getNextCounter(collectionType: string): Promise<number> {
  const { update, finish } = showSpinner('getNextCounter', `Getting next counter for ${collectionType}`);

  update('Fetching');
  const records = await getFirestore().collection(collectionType).orderBy('bin').get();
  update('Sorting');
  const ids = records.docs.map((doc: any) => parseInt(doc.id));
  update('Finding next');
  let next = 1;
  while (ids.includes(next)) {
    next++;
  }
  finish();
  return next;
}

export async function getGroup(info: Metadata) {
  const { update, finish, error } = showSpinner('getGroup', `Getting group for ${info.bin || info.skuPrefix}`);

  if (info.bin) {
    update('Getting group by bin');
    const group = await getGroupByBin(info.bin);
    if (group) {
      finish();
      return group;
    }
  }

  update(`Querying Firebase for group`);
  const db = getFirestore();
  const collection = db.collection('SalesGroups');
  const setInfo = {
    sport: info.sport.toLowerCase(),
    year: info.year.toLowerCase(),
    manufacture: info.manufacture.toLowerCase(),
    setName: info.setName.toLowerCase(),
    insert: info.insert?.toLowerCase() || null,
    parallel: info.parallel?.toLowerCase() || null,
  };
  const query = collection
    .where('keys.sport', '==', setInfo.sport)
    .where('keys.year', '==', setInfo.year)
    .where('keys.manufacture', '==', setInfo.manufacture)
    .where('keys.setName', '==', setInfo.setName)
    .where('keys.insert', '==', setInfo.insert)
    .where('keys.parallel', '==', setInfo.parallel);
  const queryResults = await query.get();

  if (queryResults.size === 0) {
    update(`No group found, creating new group`);
    const group = {
      sport: info.sport,
      year: info.year,
      manufacture: info.manufacture,
      setName: info.setName,
      insert: info.insert || null,
      parallel: info.parallel || null,
      league: info.league || 'Other',
      bin: await getNextCounter('SalesGroups'),
      keys: setInfo,
      sportlots: info.sportlots || null,
      bscFilters: info.bscFilters || null,
    };
    await collection.doc(`${group.bin}`).set(group);
    _cachedGroups[group.bin] = group;
    finish();
    return group;
  } else if (queryResults.size === 1) {
    _cachedGroups[queryResults.docs[0].id] = queryResults.docs[0].data();
    finish();
    return _cachedGroups[queryResults.docs[0].id];
  } else {
    error(
      `Found multiple groups for ${info.sport} ${info.year} ${info.setName} insert:${info.insert} parallel:${info.parallel}`,
    );
    const choices: { name: string; value: any; description: string }[] = [];
    queryResults.forEach((doc) => {
      const g = doc.data();
      choices.push({
        name: `${g.year} ${g.setName} ${g.insert} ${g.parallel}`,
        value: g,
        description: `${g.year} ${g.manufacture} ${g.setName} ${g.insert} ${g.parallel} ${g.sport}`,
      });
    });
    const response = await ask('Which group is correct?', undefined, { selectOptions: choices });
    _cachedGroups[response.bin] = response;
    finish();
    return response;
  }
}

export async function processImageFile(outputFile: string, filename: string) {
  const { finish, error } = showSpinner(`upload-${filename}`, `Uploading ${filename}`);
  try {
    await getStorage().bucket().upload(outputFile, { destination: filename });
    finish(`Uploaded ${filename} to Firebase`);
  } catch (e) {
    error(e);
  }
}

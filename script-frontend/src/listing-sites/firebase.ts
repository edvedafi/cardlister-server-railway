import { useSpinners } from '../utils/spinners';
import { getFirestore, getStorage } from '../utils/firebase';

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

export async function processImageFile(outputFile: string, filename: string) {
  const { finish, error } = showSpinner(`upload-${filename}`, `Uploading ${filename}`);
  try {
    await getStorage().bucket().upload(outputFile, { destination: filename });
    finish(`Uploaded ${filename} to Firebase`);
  } catch (e) {
    error(e);
  }
}

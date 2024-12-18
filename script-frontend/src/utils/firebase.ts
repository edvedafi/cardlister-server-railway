import { readFileSync } from 'fs';
import { type App, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore as getFirestoreAdmin } from 'firebase-admin/firestore';
import { useSpinners } from './spinners.js';
import { getStorage as getFirebaseStorage, type Storage } from 'firebase-admin/storage';

let _db: FirebaseFirestore.Firestore;
let _firebase: App;
let _storage: Storage | null;
const { showSpinner } = useSpinners('firebase', '#ffc107');
export default function initializeFirebase() {
  const { update, finish } = showSpinner('firebase', 'Firebase');
  update('Configuring');
  // @ts-expect-error - no idea why this is throwing an error, because it's correct
  const hofDBJSON = JSON.parse(readFileSync('./hofdb-2038e-firebase-adminsdk-jllij-1a5e17046b.json'));
  const firebaseConfig = {
    credential: cert(hofDBJSON),
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: 'hofdb-2038e.firebaseapp.com',
    projectId: 'hofdb-2038e',
    storageBucket: 'hofdb-2038e.appspot.com',
    messagingSenderId: '78796187147',
    appId: '1:78796187147:web:aa89f01d66d63dfc5d490e',
    measurementId: 'G-4T1D5KNQ7N',
  };
  update('Initializing');
  _firebase = initializeApp(firebaseConfig);
  update('Setting up DB');
  _db = getFirestore();
  finish('Initialized');
  return _firebase;
}

export const initializeStorage = (app: App) => {
  const {finish} = showSpinner('storage', 'Initializing Firebase Storage');
  _storage = getFirebaseStorage(app);
  finish('Using Firebase Storage');
};

export function getFirestore() {
  if (!_db) {
    _db = getFirestoreAdmin(getFirebase());
    _db.settings({ ignoreUndefinedProperties: true });
  }
  return _db;
}

export function getFirebase() {
  if (!_firebase) {
    _firebase = initializeFirebase();
  }
  return _firebase;
}

export function getStorage(): Storage {
  if (!_storage) {
    initializeStorage(getFirebase());
  }
  if (!_storage) throw "Failed to initialize storage!"
  return _storage;
}

import { type App, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore as getFirestoreAdmin } from 'firebase-admin/firestore';
import { getStorage as getFirebaseStorage, type Storage } from 'firebase-admin/storage';

let _db: FirebaseFirestore.Firestore;
let _firebase: App;
let _storage: Storage | null;

export default function initializeFirebase() {
  const json = JSON.parse(process.env.FIREBASE_CONFIG);
  console.log('json', json);
  const firebaseConfig = {
    credential: cert(json),
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: 'hofdb-2038e.firebaseapp.com',
    projectId: 'hofdb-2038e',
    storageBucket: 'hofdb-2038e.appspot.com',
    messagingSenderId: '78796187147',
    appId: '1:78796187147:web:aa89f01d66d63dfc5d490e',
    measurementId: 'G-4T1D5KNQ7N',
  };
  _firebase = initializeApp(firebaseConfig);
  return _firebase;
}

export const initializeStorage = (app: App) => {
  _storage = getFirebaseStorage(app);
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
  if (!_storage) throw 'Failed to initialize storage!';
  return _storage;
}

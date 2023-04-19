import * as admin from 'firebase-admin';

import { config } from '@/config';

let db: FirebaseFirestore.Firestore;
let _storage: admin.storage.Storage;
export function _setupFirebase(): { db: FirebaseFirestore.Firestore; storage: admin.storage.Storage } {
  if (!db) {
    admin.initializeApp({
      credential: admin.credential.cert(config.firebase.serviceAccount as admin.ServiceAccount)
    });
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    _storage = admin.storage();
  }
  return { db, storage: _storage };
}

export const { db: firestore, storage } = _setupFirebase();

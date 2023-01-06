import admin from 'firebase-admin';
import Redis from 'ioredis';
import Redlock from 'redlock';

import { config } from '@/config';

export const redis = new Redis(config.redis.connectionUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

export const redlock = new Redlock([redis.duplicate()], { retryCount: 0 });

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

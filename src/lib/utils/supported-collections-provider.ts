import { SupportedCollection } from '@infinityxyz/lib/types/core';
import { firestoreConstants } from '@infinityxyz/lib/utils';

export class SupportedCollectionsProvider {
  protected _ready: Promise<boolean>;
  protected _initialized: boolean;

  protected _supportedCollections: Set<string>;
  constructor(protected _db: FirebaseFirestore.Firestore) {
    this._supportedCollections = new Set();
    this._ready = this._init();
    this._initialized = false;
  }

  protected get supportedCollectionsQuery() {
    return this._db
      .collection(firestoreConstants.SUPPORTED_COLLECTIONS_COLL)
      .where('isSupported', '==', true) as FirebaseFirestore.Query<SupportedCollection>;
  }

  protected _init() {
    return new Promise<boolean>((resolve) => {
      let initialLoadComplete = false;
      this.supportedCollectionsQuery.onSnapshot(
        (snap) => {
          const changes = snap.docChanges();

          for (const change of changes) {
            switch (change.type) {
              case 'added':
              case 'modified': {
                const data = change.doc.data();
                const id = change.doc.id;
                if (data?.isSupported) {
                  this._supportedCollections.add(id);
                } else {
                  this._supportedCollections.delete(id);
                }
                break;
              }
              case 'removed':
                this._supportedCollections.delete(change.doc.id);
            }
          }

          if (!initialLoadComplete) {
            initialLoadComplete = true;
            resolve(true);
          }
        },
        (err) => {
          console.error(err);
          resolve(false);
        }
      );
    });
  }

  async init() {
    const success = await this._ready;
    if (!success) {
      throw new Error('Failed to initialize supported collections provider');
    }
    this._initialized = true;
  }

  has(id: string) {
    if (!this._initialized) {
      throw new Error('Must call init() before using');
    }
    return this._supportedCollections.has(id);
  }

  values() {
    if (!this._initialized) {
      throw new Error('Must call init() before using');
    }
    return this._supportedCollections.values();
  }
}

import { sleep } from '@infinityxyz/lib/utils';

import { firestore } from '../../common/db';

const MAX_BATCH_SIZE = 300;

interface Batch {
  batch: FirebaseFirestore.WriteBatch;
  size: number;
}

export class BatchHandler {
  private currentBatch: Batch;

  private db: FirebaseFirestore.Firestore;

  constructor(protected _limit = MAX_BATCH_SIZE) {
    this.db = firestore;
    this.currentBatch = this.newBatch();
  }

  get size(): number {
    return this.currentBatch.size;
  }

  add(
    doc: FirebaseFirestore.DocumentReference,
    object: Partial<FirebaseFirestore.DocumentData>,
    options: FirebaseFirestore.SetOptions
  ): void {
    this.checkSize();
    this.currentBatch.batch.set(doc, object, options);
    this.currentBatch.size += 1;
  }

  async addAsync(
    doc: FirebaseFirestore.DocumentReference,
    object: Partial<FirebaseFirestore.DocumentData>,
    options: FirebaseFirestore.SetOptions
  ): Promise<void> {
    await this.checkSizeAsync();
    this.currentBatch.batch.set(doc, object, options);
    this.currentBatch.size += 1;
  }

  async deleteAsync(doc: FirebaseFirestore.DocumentReference): Promise<void> {
    await this.checkSizeAsync();
    this.currentBatch.batch.delete(doc);
    this.currentBatch.size += 1;
  }

  delete(doc: FirebaseFirestore.DocumentReference): void {
    this.checkSize();
    this.currentBatch.batch.delete(doc);
    this.currentBatch.size += 1;
  }

  private checkSize(): void {
    if (this.currentBatch.size >= this._limit) {
      this.flush().catch((err) => {
        console.error(err);
      });
    }
  }

  private async checkSizeAsync(): Promise<void> {
    if (this.currentBatch.size >= this._limit) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.currentBatch.size > 0) {
      const maxAttempts = 3;
      let attempt = 0;
      const batch = this.currentBatch.batch;
      this.currentBatch = this.newBatch();
      for (;;) {
        attempt += 1;
        try {
          await batch.commit();
          return;
        } catch (err) {
          // Logger.error('Failed to commit batch', err);
          if (attempt > maxAttempts) {
            console.error(`Failed to commit batch`);
            throw err;
          }
          await sleep(1000); // Firebase has a limit of 1 write per doc per second
        }
      }
    }
  }

  private newBatch(): Batch {
    return {
      batch: this.db.batch(),
      size: 0
    };
  }
}

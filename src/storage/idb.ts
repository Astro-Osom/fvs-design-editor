/** A very small promise layer over IndexedDB. */

const DB_NAME = 'fvs-design-editor';
// Version 2 added the font stores. Version 3 added the store for downloaded models.
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction has committed; rejects if it aborted (for example on a full disk). */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fontFiles')) db.createObjectStore('fontFiles', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fontFamilies')) db.createObjectStore('fontFamilies', { keyPath: 'family' });
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // If another tab upgrades the database, let go so it is not blocked.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open browser storage'));
      request.onblocked = () => reject(new Error('Browser storage is blocked by another tab'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** For tests: forget the cached connection. */
export function resetDatabaseConnection(): void {
  dbPromise = null;
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}

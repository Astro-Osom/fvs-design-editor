import type { AssetId } from '../document/types';
import { openDatabase, requestToPromise, transactionDone } from '../storage/idb';

/**
 * Where original asset bytes live.
 *
 * Assets are identified by the SHA-256 of their bytes. Object URLs are only ever
 * created to decode an image and are never stored or used as identity.
 */
export interface StoredAsset {
  id: AssetId;
  mime: string;
  bytes: Uint8Array;
}

export interface AssetStore {
  put(asset: StoredAsset): Promise<void>;
  get(id: AssetId): Promise<StoredAsset | undefined>;
  has(id: AssetId): Promise<boolean>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class MemoryAssetStore implements AssetStore {
  private readonly items = new Map<AssetId, StoredAsset>();

  async put(asset: StoredAsset): Promise<void> {
    this.items.set(asset.id, asset);
  }

  async get(id: AssetId): Promise<StoredAsset | undefined> {
    return this.items.get(id);
  }

  async has(id: AssetId): Promise<boolean> {
    return this.items.has(id);
  }
}

/** Assets in IndexedDB, stored as raw bytes (not Blobs) for the widest browser support. */
export class IdbAssetStore implements AssetStore {
  async put(asset: StoredAsset): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put({ id: asset.id, mime: asset.mime, bytes: asset.bytes });
    await transactionDone(tx);
  }

  async get(id: AssetId): Promise<StoredAsset | undefined> {
    const db = await openDatabase();
    const row = await requestToPromise<StoredAsset | undefined>(
      db.transaction('assets', 'readonly').objectStore('assets').get(id),
    );
    return row ? { id: row.id, mime: row.mime, bytes: new Uint8Array(row.bytes) } : undefined;
  }

  async has(id: AssetId): Promise<boolean> {
    const db = await openDatabase();
    const count = await requestToPromise<number>(
      db.transaction('assets', 'readonly').objectStore('assets').count(id),
    );
    return count > 0;
  }
}

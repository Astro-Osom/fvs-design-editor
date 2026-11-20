import type { DocumentFont, FontFaceRecord, FontFileRef } from '../document/types';
import { openDatabase, requestToPromise, transactionDone } from '../storage/idb';

/**
 * Where font files live on this machine, and which families have been collected.
 *
 * Font files are kept like image assets: raw bytes under the SHA-256 of those
 * bytes. The library records the families the person has downloaded from Google
 * Fonts or added from a file, so they can be used again without a network.
 * Fonts installed on the computer are not copied here unless the person chooses
 * to include one in a project.
 */

export interface StoredFontFile {
  id: string;
  bytes: Uint8Array;
}

export interface LibraryFont {
  family: string;
  source: 'google' | 'file';
  license?: string;
  embeddable: boolean;
  files: FontFileRef[];
  faces: FontFaceRecord[];
  addedAt: string;
}

export interface FontStore {
  putFile(file: StoredFontFile): Promise<void>;
  getFile(id: string): Promise<StoredFontFile | undefined>;
  hasFile(id: string): Promise<boolean>;
  putFamily(font: LibraryFont): Promise<void>;
  getFamily(family: string): Promise<LibraryFont | undefined>;
  listFamilies(): Promise<LibraryFont[]>;
  deleteFamily(family: string): Promise<void>;
}

/** The record a design keeps when it starts using a library font. */
export function documentFontFromLibrary(font: LibraryFont): DocumentFont {
  const record: DocumentFont = {
    family: font.family,
    source: font.source,
    embeddable: font.embeddable,
    // Openly licensed fonts always travel with the project. Added files only if the person says so.
    embed: font.source === 'google',
    files: font.files,
    faces: font.faces,
  };
  if (font.license) record.license = font.license;
  return record;
}

export class MemoryFontStore implements FontStore {
  private readonly files = new Map<string, StoredFontFile>();
  private readonly families = new Map<string, LibraryFont>();

  async putFile(file: StoredFontFile): Promise<void> {
    this.files.set(file.id, file);
  }

  async getFile(id: string): Promise<StoredFontFile | undefined> {
    return this.files.get(id);
  }

  async hasFile(id: string): Promise<boolean> {
    return this.files.has(id);
  }

  async putFamily(font: LibraryFont): Promise<void> {
    this.families.set(font.family, font);
  }

  async getFamily(family: string): Promise<LibraryFont | undefined> {
    return this.families.get(family);
  }

  async listFamilies(): Promise<LibraryFont[]> {
    return [...this.families.values()];
  }

  async deleteFamily(family: string): Promise<void> {
    this.families.delete(family);
  }
}

export class IdbFontStore implements FontStore {
  async putFile(file: StoredFontFile): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction('fontFiles', 'readwrite');
    tx.objectStore('fontFiles').put({ id: file.id, bytes: file.bytes });
    await transactionDone(tx);
  }

  async getFile(id: string): Promise<StoredFontFile | undefined> {
    const db = await openDatabase();
    const row = await requestToPromise<StoredFontFile | undefined>(db.transaction('fontFiles', 'readonly').objectStore('fontFiles').get(id));
    return row ? { id: row.id, bytes: new Uint8Array(row.bytes) } : undefined;
  }

  async hasFile(id: string): Promise<boolean> {
    const db = await openDatabase();
    return (await requestToPromise<number>(db.transaction('fontFiles', 'readonly').objectStore('fontFiles').count(id))) > 0;
  }

  async putFamily(font: LibraryFont): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction('fontFamilies', 'readwrite');
    tx.objectStore('fontFamilies').put(font);
    await transactionDone(tx);
  }

  async getFamily(family: string): Promise<LibraryFont | undefined> {
    const db = await openDatabase();
    return requestToPromise<LibraryFont | undefined>(db.transaction('fontFamilies', 'readonly').objectStore('fontFamilies').get(family));
  }

  async listFamilies(): Promise<LibraryFont[]> {
    const db = await openDatabase();
    return requestToPromise<LibraryFont[]>(db.transaction('fontFamilies', 'readonly').objectStore('fontFamilies').getAll());
  }

  async deleteFamily(family: string): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction('fontFamilies', 'readwrite');
    tx.objectStore('fontFamilies').delete(family);
    await transactionDone(tx);
  }
}

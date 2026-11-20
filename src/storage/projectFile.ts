import { strFromU8, strToU8, unzip, zip, type Unzipped, type Zippable } from 'fflate';
import { sha256Hex, type StoredAsset } from '../assets/assetStore';
import { fontsUsed, pruneUnusedAssets } from '../document/ops';
import { DocumentError, parseDocument } from '../document/schema';
import type { AssetId, DesignDocument, FontUse } from '../document/types';

/**
 * The portable project file (`.fvsdesign`).
 *
 * It is a zip archive that holds everything needed to reopen a design on another
 * machine with no network:
 *
 *   manifest.json            what this file is, and which fonts the design uses
 *   document.json            the design document (see src/document/types.ts)
 *   assets/<sha256>.<ext>    every original image, byte for byte
 */

export const PROJECT_FILE_EXTENSION = 'fvsdesign';
export const PROJECT_FILE_MIME = 'application/vnd.fvs.design+zip';
const FORMAT = 'fvs-design-project';
const FORMAT_VERSION = 1;

export interface ProjectManifest {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  savedAt: string;
  documentId: string;
  documentName: string;
  fonts: FontUse[];
}

export class ProjectFileError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-project' | 'newer-version' | 'damaged',
  ) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function zipAsync(files: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, (err, data) => (err ? reject(err) : resolve(data))));
}

function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => unzip(bytes, (err, data) => (err ? reject(err) : resolve(data))));
}

export interface PackOptions {
  doc: DesignDocument;
  /** Returns the original bytes for an asset, or undefined if they cannot be found. */
  getAsset(id: AssetId): Promise<StoredAsset | undefined>;
  appVersion: string;
  now?: Date;
}

export interface PackResult {
  bytes: Uint8Array;
  /** Assets the document uses whose bytes could not be found. The file is still written. */
  missingAssets: AssetId[];
}

export async function packProject(options: PackOptions): Promise<PackResult> {
  const doc = pruneUnusedAssets(options.doc);
  const manifest: ProjectManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: options.appVersion,
    savedAt: (options.now ?? new Date()).toISOString(),
    documentId: doc.id,
    documentName: doc.name,
    fonts: fontsUsed(doc),
  };
  const files: Zippable = {
    'manifest.json': [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
    'document.json': [strToU8(JSON.stringify(doc, null, 2)), { level: 6 }],
  };
  const missingAssets: AssetId[] = [];
  for (const info of Object.values(doc.assets)) {
    const stored = await options.getAsset(info.id);
    if (!stored) {
      missingAssets.push(info.id);
      continue;
    }
    const ext = EXTENSION_BY_MIME[info.mime] ?? 'bin';
    // Images are already compressed, so store them as they are.
    files[`assets/${info.id}.${ext}`] = [stored.bytes, { level: 0 }];
  }
  return { bytes: await zipAsync(files), missingAssets };
}

export interface UnpackResult {
  doc: DesignDocument;
  manifest: ProjectManifest;
  assets: StoredAsset[];
  /** Listed in the document but absent from the file. */
  missingAssets: AssetId[];
  /** Present in the file but the bytes do not match their id (the file was altered or damaged). */
  corruptAssets: AssetId[];
  /** Set when the document was upgraded from an older format while opening. */
  migratedFrom: number | null;
}

export async function unpackProject(bytes: Uint8Array): Promise<UnpackResult> {
  let entries: Unzipped;
  try {
    entries = await unzipAsync(bytes);
  } catch {
    throw new ProjectFileError('This file is not a design project, or it is damaged.', 'not-a-project');
  }
  const manifestBytes = entries['manifest.json'];
  const documentBytes = entries['document.json'];
  if (!manifestBytes || !documentBytes) {
    throw new ProjectFileError('This file is not a design project.', 'not-a-project');
  }

  let manifest: ProjectManifest;
  let rawDoc: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as ProjectManifest;
    rawDoc = JSON.parse(strFromU8(documentBytes));
  } catch {
    throw new ProjectFileError('The project file is damaged and cannot be read.', 'damaged');
  }
  if (manifest?.format !== FORMAT) {
    throw new ProjectFileError('This file is not a design project.', 'not-a-project');
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > FORMAT_VERSION) {
    throw new ProjectFileError(
      'This project was saved by a newer version of the editor. Update the editor to open it.',
      'newer-version',
    );
  }

  let parsed: ReturnType<typeof parseDocument>;
  try {
    parsed = parseDocument(rawDoc);
  } catch (error) {
    if (error instanceof DocumentError) {
      throw new ProjectFileError(error.message, error.code === 'newer-version' ? 'newer-version' : 'damaged');
    }
    throw error;
  }

  const byId = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(entries)) {
    const match = /^assets\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(path);
    if (match) byId.set(match[1]!, data);
  }

  const assets: StoredAsset[] = [];
  const missingAssets: AssetId[] = [];
  const corruptAssets: AssetId[] = [];
  for (const info of Object.values(parsed.doc.assets)) {
    const data = byId.get(info.id);
    if (!data) {
      missingAssets.push(info.id);
      continue;
    }
    if ((await sha256Hex(data)) !== info.id) {
      corruptAssets.push(info.id);
      continue;
    }
    assets.push({ id: info.id, mime: info.mime, bytes: data });
  }

  return { doc: parsed.doc, manifest, assets, missingAssets, corruptAssets, migratedFrom: parsed.migratedFrom };
}

export function projectFileName(documentName: string): string {
  const safe = documentName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${safe || 'Untitled design'}.${PROJECT_FILE_EXTENSION}`;
}

import { strFromU8, strToU8, unzip, zip, type Unzipped, type Zippable } from 'fflate';
import { sha256Hex, type StoredAsset } from '../assets/assetStore';
import { fontUseRecords, pruneUnusedAssets, pruneUnusedFonts } from '../document/ops';
import { DocumentError, parseDocument } from '../document/schema';
import type { AssetId, DesignDocument, FontUseRecord } from '../document/types';
import type { StoredFontFile } from '../fonts/fontStore';

/**
 * The portable project file (`.fvsdesign`).
 *
 * It is a zip archive that holds everything needed to reopen a design on another
 * machine with no network:
 *
 *   manifest.json            what this file is, and which fonts the design uses
 *   document.json            the design document (see src/document/types.ts)
 *   assets/<sha256>.<ext>    every original image, byte for byte
 *   fonts/<sha256>.<ext>     font files the design is allowed to carry (see below)
 *
 * Fonts: a font's files are included only when the design marks it `embed`, which
 * is always the case for openly licensed Google fonts and never the case for a
 * font whose own embedding permission forbids it. Other fonts are recorded by
 * name, and a missing-font warning is shown where they are not available.
 */

export const PROJECT_FILE_EXTENSION = 'fvsdesign';
export const PROJECT_FILE_MIME = 'application/vnd.fvs.design+zip';
const FORMAT = 'fvs-design-project';
// Version 2 added the fonts folder.
const FORMAT_VERSION = 2;

export interface ProjectManifest {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  savedAt: string;
  documentId: string;
  documentName: string;
  /** Every font face the design uses, and where it comes from. */
  fonts: FontUseRecord[];
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
  /** Returns the bytes of a font file, or undefined if they cannot be found. */
  getFontFile?(id: string): Promise<StoredFontFile | undefined>;
  appVersion: string;
  now?: Date;
}

export interface PackResult {
  bytes: Uint8Array;
  /** Assets the document uses whose bytes could not be found. The file is still written. */
  missingAssets: AssetId[];
  /** Families that should travel with the project but whose files could not be found. */
  missingFonts: string[];
}

export async function packProject(options: PackOptions): Promise<PackResult> {
  const doc = pruneUnusedFonts(pruneUnusedAssets(options.doc));
  const manifest: ProjectManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: options.appVersion,
    savedAt: (options.now ?? new Date()).toISOString(),
    documentId: doc.id,
    documentName: doc.name,
    fonts: fontUseRecords(doc),
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
  const missingFonts: string[] = [];
  for (const font of doc.fonts) {
    if (!font.embed) continue;
    for (const file of font.files) {
      const path = `fonts/${file.id}.${file.format}`;
      if (files[path]) continue;
      const stored = await options.getFontFile?.(file.id);
      if (!stored) {
        if (!missingFonts.includes(font.family)) missingFonts.push(font.family);
        continue;
      }
      // WOFF and WOFF2 are already compressed; plain font files shrink well.
      files[path] = [stored.bytes, { level: file.format === 'ttf' || file.format === 'otf' ? 6 : 0 }];
    }
  }
  return { bytes: await zipAsync(files), missingAssets, missingFonts };
}

export interface UnpackResult {
  doc: DesignDocument;
  manifest: ProjectManifest;
  assets: StoredAsset[];
  /** Listed in the document but absent from the file. */
  missingAssets: AssetId[];
  /** Present in the file but the bytes do not match their id (the file was altered or damaged). */
  corruptAssets: AssetId[];
  /** Font files found in the project, already checked against their ids. */
  fontFiles: StoredFontFile[];
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

  // Font files: keep only those the design refers to and whose bytes match their id.
  // A font that is missing or altered simply stays unavailable, and is reported as a missing font.
  const wantedFonts = new Set(parsed.doc.fonts.flatMap((font) => font.files.map((file) => file.id)));
  const fontFiles: StoredFontFile[] = [];
  for (const [path, data] of Object.entries(entries)) {
    const match = /^fonts\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(path);
    if (!match || !wantedFonts.has(match[1]!)) continue;
    if ((await sha256Hex(data)) === match[1]) fontFiles.push({ id: match[1]!, bytes: data });
  }

  return { doc: parsed.doc, manifest, assets, missingAssets, corruptAssets, fontFiles, migratedFrom: parsed.migratedFrom };
}

export function projectFileName(documentName: string): string {
  const safe = documentName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${safe || 'Untitled design'}.${PROJECT_FILE_EXTENSION}`;
}

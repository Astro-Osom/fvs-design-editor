import { unzlibSync } from 'fflate';
import type { FontFormat } from '../document/types';
import { stripWeightFromFamily } from './styleNames';

/**
 * Reads the few facts the editor needs from a font file: its names, weight,
 * whether it is italic, and the embedding permission its maker set.
 *
 * Handles TrueType and OpenType files (.ttf, .otf), collections (.ttc) and WOFF.
 * WOFF2 is recognised but cannot be read here: its tables are Brotli-compressed
 * and browsers do not offer a Brotli decoder to pages.
 */

/**
 * What the font's maker allows, from the `fsType` field of its OS/2 table.
 * - installable: may be embedded and installed.
 * - editable: may be embedded in documents that are edited.
 * - preview-print: may only be embedded in documents that are viewed or printed.
 * - restricted: may not be embedded at all.
 * - bitmap-only: only bitmap versions may be embedded.
 * - unknown: the font does not say.
 */
export type EmbeddingPermission = 'installable' | 'editable' | 'preview-print' | 'restricted' | 'bitmap-only' | 'unknown';

export function embeddingPermission(fsType: number | null): EmbeddingPermission {
  if (fsType === null) return 'unknown';
  if (fsType & 0x0200) return 'bitmap-only';
  const level = fsType & 0x000e;
  if (level === 0) return 'installable';
  // If several levels are set, the least restrictive one applies (OS/2 versions 0 to 2).
  if (level & 0x0008) return 'editable';
  if (level & 0x0004) return 'preview-print';
  return 'restricted';
}

/**
 * A project file is a document that is edited, and it carries the whole font
 * file. So the font must allow at least editable embedding. Anything else,
 * including a font that does not say, is not embedded.
 */
export function mayEmbedInProject(permission: EmbeddingPermission): boolean {
  return permission === 'installable' || permission === 'editable';
}

export interface FontInfo {
  format: FontFormat;
  /** True for a collection of several fonts in one file. Browsers cannot load these from data. */
  collection: boolean;
  family: string;
  subfamily: string;
  fullName: string;
  postscriptName: string;
  /** 1 to 1000; 400 is regular and 700 is bold. */
  weight: number;
  italic: boolean;
  /** 1 (very narrow) to 9 (very wide); 5 is normal. */
  width: number;
  fsType: number | null;
  embedding: EmbeddingPermission;
  /** For a variable font, the range of weights it can produce. */
  weightRange: [number, number] | null;
}

export class FontParseError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-font' | 'woff2' | 'damaged',
  ) {
    super(message);
    this.name = 'FontParseError';
  }
}

const tagAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** The container format, from the first four bytes. Returns null if this is not a font file. */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | 'ttc' | null {
  if (bytes.length < 12) return null;
  const tag = tagAt(bytes, 0);
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'ttcf') return 'ttc';
  if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf';
  return null;
}

type TableReader = (tag: string) => Uint8Array | null;

function sfntTables(bytes: Uint8Array, base: number): TableReader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(base + 4);
  const records = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const at = base + 12 + i * 16;
    if (at + 16 > bytes.length) break;
    records.set(tagAt(bytes, at), [view.getUint32(at + 8), view.getUint32(at + 12)]);
  }
  return (tag) => {
    const record = records.get(tag);
    if (!record || record[0] + record[1] > bytes.length) return null;
    return bytes.subarray(record[0], record[0] + record[1]);
  };
}

function woffTables(bytes: Uint8Array): TableReader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(12);
  const records = new Map<string, [number, number, number]>();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    if (at + 20 > bytes.length) break;
    records.set(tagAt(bytes, at), [view.getUint32(at + 4), view.getUint32(at + 8), view.getUint32(at + 12)]);
  }
  return (tag) => {
    const record = records.get(tag);
    if (!record) return null;
    const [offset, compressedLength, length] = record;
    if (offset + compressedLength > bytes.length) return null;
    const data = bytes.subarray(offset, offset + compressedLength);
    if (compressedLength === length) return data;
    try {
      return unzlibSync(data);
    } catch {
      return null;
    }
  };
}

function decodeName(bytes: Uint8Array, platform: number): string {
  try {
    if (platform === 1) return new TextDecoder('macintosh').decode(bytes);
    return new TextDecoder('utf-16be').decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function readNames(table: Uint8Array | null): Map<number, string> {
  const names = new Map<number, string>();
  if (!table || table.length < 6) return names;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = view.getUint16(2);
  const stringOffset = view.getUint16(4);
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const platform = view.getUint16(at);
    const language = view.getUint16(at + 4);
    const nameId = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = stringOffset + view.getUint16(at + 10);
    if (offset + length > table.length) continue;
    // Prefer Windows English, then any Windows name, then Unicode, then Mac English.
    const score = platform === 3 ? (language === 0x0409 ? 4 : 3) : platform === 0 ? 2 : platform === 1 && language === 0 ? 1 : 0;
    if (score === 0 || score <= (rank.get(nameId) ?? 0)) continue;
    const text = decodeName(table.subarray(offset, offset + length), platform).replace(/\u0000/g, '').trim();
    if (!text) continue;
    rank.set(nameId, score);
    names.set(nameId, text);
  }
  return names;
}

function fixed(view: DataView, offset: number): number {
  return view.getInt32(offset) / 65536;
}

function readWeightRange(table: Uint8Array | null): [number, number] | null {
  if (!table || table.length < 16) return null;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const axesOffset = view.getUint16(4);
  const axisCount = view.getUint16(8);
  const axisSize = view.getUint16(10);
  for (let i = 0; i < axisCount; i++) {
    const at = axesOffset + i * axisSize;
    if (at + 16 > table.length) break;
    if (tagAt(table, at) === 'wght') return [Math.round(fixed(view, at + 4)), Math.round(fixed(view, at + 12))];
  }
  return null;
}

/**
 * Read a font file's facts. For a collection, `postscriptName` picks the member
 * with that name (the first one otherwise).
 */
export function parseFontInfo(bytes: Uint8Array, postscriptName?: string): FontInfo {
  const kind = sniffFontFormat(bytes);
  if (!kind) throw new FontParseError('This is not a font file.', 'not-a-font');
  if (kind === 'woff2') {
    throw new FontParseError('This kind of font file (.woff2) cannot be read here. Use the .ttf or .otf version of the font.', 'woff2');
  }
  try {
    if (kind !== 'ttc') {
      const reader = kind === 'woff' ? woffTables(bytes) : sfntTables(bytes, 0);
      return infoFromTables(reader, kind, false);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(8);
    let first: FontInfo | null = null;
    for (let i = 0; i < count; i++) {
      const base = view.getUint32(12 + i * 4);
      const info = infoFromTables(sfntTables(bytes, base), tagAt(bytes, base) === 'OTTO' ? 'otf' : 'ttf', true);
      if (!postscriptName || info.postscriptName === postscriptName) return info;
      first ??= info;
    }
    if (first) return first;
    throw new FontParseError('The font collection is empty.', 'damaged');
  } catch (error) {
    if (error instanceof FontParseError) throw error;
    throw new FontParseError('The font file is damaged and cannot be read.', 'damaged');
  }
}

const NEEDED_TABLES = ['name', 'OS/2', 'head', 'post', 'fvar'];
const MAX_TABLE_BYTES = 8 * 1024 * 1024;

async function slice(blob: Blob, start: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

/** Read one font's facts from a file without loading the whole file: only its directory and a few small tables. */
async function infoFromBlobAt(blob: Blob, base: number, collection: boolean): Promise<FontInfo> {
  const header = await slice(blob, base, 12);
  const count = new DataView(header.buffer).getUint16(4);
  const directory = await slice(blob, base + 12, count * 16);
  const view = new DataView(directory.buffer);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const tag = tagAt(directory, i * 16);
    const length = view.getUint32(i * 16 + 12);
    if (!NEEDED_TABLES.includes(tag) || length > MAX_TABLE_BYTES) continue;
    tables.set(tag, await slice(blob, view.getUint32(i * 16 + 8), length));
  }
  return infoFromTables((tag) => tables.get(tag) ?? null, tagAt(header, 0) === 'OTTO' ? 'otf' : 'ttf', collection);
}

/**
 * Like `parseFontInfo`, for a file that may be very large (installed fonts for
 * Chinese, Japanese or Korean can be tens of megabytes each). Only the parts
 * that are needed are read into memory.
 */
export async function parseFontInfoFromBlob(blob: Blob, postscriptName?: string): Promise<FontInfo> {
  const start = await slice(blob, 0, 12);
  const kind = sniffFontFormat(start);
  if (!kind) throw new FontParseError('This is not a font file.', 'not-a-font');
  try {
    if (kind === 'ttf' || kind === 'otf') return await infoFromBlobAt(blob, 0, false);
    if (kind === 'ttc') {
      const count = new DataView(start.buffer).getUint32(8);
      const offsets = new DataView((await slice(blob, 12, count * 4)).buffer);
      let first: FontInfo | null = null;
      for (let i = 0; i < count; i++) {
        const info = await infoFromBlobAt(blob, offsets.getUint32(i * 4), true);
        if (!postscriptName || info.postscriptName === postscriptName) return info;
        first ??= info;
      }
      if (first) return first;
      throw new FontParseError('The font collection is empty.', 'damaged');
    }
  } catch (error) {
    if (error instanceof FontParseError) throw error;
    throw new FontParseError('The font file is damaged and cannot be read.', 'damaged');
  }
  // WOFF and WOFF2 are compressed as a whole; these are small web fonts, so read them fully.
  return parseFontInfo(new Uint8Array(await blob.arrayBuffer()), postscriptName);
}

function infoFromTables(table: TableReader, format: FontFormat, collection: boolean): FontInfo {
  const names = readNames(table('name'));
  const typographicFamily = names.get(16);
  const namedFamily = typographicFamily ?? names.get(1) ?? '';
  if (!namedFamily) throw new FontParseError('The font file does not say what it is called.', 'damaged');
  const subfamily = names.get(17) ?? names.get(2) ?? 'Regular';

  const os2 = table('OS/2');
  const head = table('head');
  const post = table('post');
  const os2View = os2 && os2.length >= 10 ? new DataView(os2.buffer, os2.byteOffset, os2.byteLength) : null;
  const macStyle = head && head.length >= 46 ? new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(44) : 0;

  let weight = os2View ? os2View.getUint16(4) : macStyle & 1 ? 700 : 400;
  // Some old fonts use a 1 to 9 scale.
  if (weight >= 1 && weight <= 9) weight *= 100;
  weight = Math.min(1000, Math.max(1, weight || 400));

  const fsSelection = os2View && os2View.byteLength >= 64 ? os2View.getUint16(62) : 0;
  const italicAngle = post && post.length >= 8 ? fixed(new DataView(post.buffer, post.byteOffset, post.byteLength), 4) : 0;
  const italic = !!(fsSelection & 0x0201) || !!(macStyle & 2) || italicAngle !== 0;

  const fsType = os2View ? os2View.getUint16(8) : null;
  const width = os2View ? os2View.getUint16(6) || 5 : 5;

  // Without a separate family name, "Inter ExtraBold" means the ExtraBold weight of Inter.
  const family = typographicFamily ?? stripWeightFromFamily(namedFamily, weight);

  return {
    format,
    collection,
    family,
    subfamily,
    fullName: names.get(4) ?? `${family} ${subfamily}`,
    postscriptName: names.get(6) ?? '',
    weight,
    italic,
    width,
    fsType,
    embedding: embeddingPermission(fsType),
    weightRange: readWeightRange(table('fvar')),
  };
}

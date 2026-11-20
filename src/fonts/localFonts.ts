import { sha256Hex } from '../assets/assetStore';
import type { DocumentFont, FontFaceRecord, FontFileRef } from '../document/types';
import { mayEmbedInProject, parseFontInfoFromBlob, type FontInfo } from './fontInfo';
import type { FontStore } from './fontStore';
import { guessStyle } from './styleNames';

/**
 * Fonts installed on the person's computer.
 *
 * The Local Font Access API (`window.queryLocalFonts`) lists them, after the
 * person allows it. It exists in Chromium browsers and in the desktop app, not
 * in Firefox or Safari. An installed font is used where it is: the design keeps
 * its name, and nothing is copied or uploaded unless the person chooses to
 * include the font in a project and the font's own permission allows it.
 */

/** One installed face, as the browser describes it. */
export interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

type QueryLocalFonts = (options?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;

function api(): QueryLocalFonts | undefined {
  return (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
}

export function localFontsSupported(): boolean {
  return typeof api() === 'function';
}

export type LocalFontsPermission = 'granted' | 'prompt' | 'denied' | 'unsupported';

export async function localFontsPermission(): Promise<LocalFontsPermission> {
  if (!localFontsSupported()) return 'unsupported';
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    return status.state;
  } catch {
    return 'prompt';
  }
}

export interface LocalFace {
  postscriptName: string;
  fullName: string;
  /** The style name the system reports, e.g. "Bold Italic". */
  styleName: string;
  weight: number;
  italic: boolean;
}

export interface LocalFamily {
  /** The name shown and used in the design. A narrow or wide variant gets its own entry, e.g. "Futura Condensed". */
  family: string;
  faces: LocalFace[];
}

/** Group installed faces into the families shown in the font list, sorted by name. */
export function groupLocalFonts(fonts: readonly Omit<LocalFontData, 'blob'>[]): LocalFamily[] {
  const groups = new Map<string, LocalFamily>();
  for (const font of fonts) {
    if (!font.family || !font.postscriptName || font.family.startsWith('.')) continue;
    const guess = guessStyle(font.style);
    const name = guess.rest ? `${font.family} ${guess.rest}` : font.family;
    let group = groups.get(name);
    if (!group) groups.set(name, (group = { family: name, faces: [] }));
    // One face per weight and style: the first the system lists wins.
    if (group.faces.some((face) => face.weight === guess.weight && face.italic === guess.italic)) continue;
    group.faces.push({
      postscriptName: font.postscriptName,
      fullName: font.fullName,
      styleName: font.style,
      weight: guess.weight,
      italic: guess.italic,
    });
  }
  return [...groups.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export class LocalFontsError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'denied',
  ) {
    super(message);
    this.name = 'LocalFontsError';
  }
}

async function query(postscriptNames?: string[]): Promise<LocalFontData[]> {
  const queryLocalFonts = api();
  if (!queryLocalFonts) {
    throw new LocalFontsError('This browser cannot list the fonts on your computer. Add a font file instead.', 'unsupported');
  }
  try {
    // The first call in a browser session can take many seconds on a computer with a
    // lot of fonts (about 20 seconds for 1,000 font files); later calls are instant.
    return await (postscriptNames ? queryLocalFonts({ postscriptNames }) : queryLocalFonts());
  } catch {
    throw new LocalFontsError('The browser did not allow the fonts on this computer to be listed.', 'denied');
  }
}

/**
 * List the fonts on this computer. The first call must come from a click, because
 * the browser asks the person for permission. An empty list after asking means
 * the answer was no.
 */
export async function listLocalFamilies(): Promise<LocalFamily[]> {
  const fonts = await query();
  if (!fonts.length && (await localFontsPermission()) !== 'granted') {
    throw new LocalFontsError('The browser did not allow the fonts on this computer to be listed.', 'denied');
  }
  return groupLocalFonts(fonts);
}

/** An installed font larger than this is not copied into projects. */
const MAX_EMBED_BYTES = 40 * 1024 * 1024;

interface ReadFace {
  face: LocalFace;
  blob: Blob | null;
  info: FontInfo | null;
}

/** Read what each face says about itself. Only a few small tables are read, not the whole file. */
async function readFaces(family: LocalFamily): Promise<ReadFace[]> {
  const data = await query(family.faces.map((face) => face.postscriptName));
  const byName = new Map(data.map((font) => [font.postscriptName, font]));
  return Promise.all(
    family.faces.map(async (face) => {
      try {
        const blob = await byName.get(face.postscriptName)!.blob();
        return { face, blob, info: await parseFontInfoFromBlob(blob, face.postscriptName) };
      } catch {
        return { face, blob: null, info: null };
      }
    }),
  );
}

function facesOf(read: readonly ReadFace[]): { faces: FontFaceRecord[]; kept: ReadFace[] } {
  const faces: FontFaceRecord[] = [];
  const kept: ReadFace[] = [];
  for (const item of read) {
    // The font's own data is more reliable than its style name.
    const weight = item.info?.weight ?? item.face.weight;
    const style = (item.info?.italic ?? item.face.italic) ? 'italic' : 'normal';
    if (faces.some((face) => face.weight === weight && face.style === style)) continue;
    faces.push({ weight, style, files: [], localName: item.face.postscriptName });
    kept.push(item);
  }
  return { faces, kept };
}

/** Whether every face can be read and its maker allows embedding in documents that are edited. */
function allEmbeddable(read: readonly ReadFace[]): boolean {
  return (
    read.length > 0 &&
    read.every((item) => !!item.blob && item.blob.size <= MAX_EMBED_BYTES && !!item.info && !item.info.collection && mayEmbedInProject(item.info.embedding))
  );
}

/**
 * The record a design keeps for an installed family. It holds names only: the
 * font is looked up on the computer each time the design is opened.
 */
export async function installedDocumentFont(family: LocalFamily): Promise<DocumentFont> {
  const read = await readFaces(family);
  const { faces, kept } = facesOf(read);
  return { family: family.family, source: 'installed', embeddable: allEmbeddable(kept), embed: false, files: [], faces };
}

/**
 * Copy an installed family's files into the font store so they can travel inside
 * a project file. Only call this when the person asked for it and the font is
 * `embeddable`. Returns the updated record, or null if the files cannot be read
 * any more.
 */
export async function embedInstalledFont(font: DocumentFont, store: FontStore): Promise<DocumentFont | null> {
  if (font.source !== 'installed' || !font.embeddable) return null;
  const family: LocalFamily = {
    family: font.family,
    faces: font.faces.flatMap((face) =>
      face.localName ? [{ postscriptName: face.localName, fullName: '', styleName: '', weight: face.weight, italic: face.style === 'italic' }] : [],
    ),
  };
  const read = await readFaces(family);
  if (read.length !== font.faces.length || !allEmbeddable(read)) return null;
  const files: FontFileRef[] = [];
  const faces: FontFaceRecord[] = [];
  for (const [index, item] of read.entries()) {
    const bytes = new Uint8Array(await item.blob!.arrayBuffer());
    const id = await sha256Hex(bytes);
    if (!(await store.hasFile(id))) await store.putFile({ id, bytes });
    let fileIndex = files.findIndex((file) => file.id === id);
    if (fileIndex < 0) fileIndex = files.push({ id, bytes: bytes.length, format: item.info!.format }) - 1;
    faces.push({ ...font.faces[index]!, files: [fileIndex] });
  }
  return { ...font, embed: true, files, faces };
}

/** Stop including an installed family: the design goes back to keeping its name only. */
export function unembedInstalledFont(font: DocumentFont): DocumentFont {
  return { ...font, embed: false, files: [], faces: font.faces.map((face) => ({ ...face, files: [] })) };
}

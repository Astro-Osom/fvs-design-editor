import { sha256Hex } from '../assets/assetStore';
import type { FontFaceRecord, FontFileRef } from '../document/types';
import { FontParseError, mayEmbedInProject, parseFontInfo, type FontInfo } from './fontInfo';
import type { FontStore, LibraryFont } from './fontStore';

/**
 * Font files the person adds themselves (.ttf, .otf, .woff).
 *
 * The files stay on this machine. Whether they may be put inside a project file
 * depends on the embedding permission the font's maker set (see fontInfo.ts),
 * and even then only if the person chooses to.
 */

export const FONT_FILE_ACCEPT = '.ttf,.otf,.woff,font/ttf,font/otf,font/woff';

export interface FontFileInput {
  name: string;
  bytes: Uint8Array;
}

export interface AddFontFilesResult {
  /** Families that were added or extended, as they now are in the library. */
  fonts: LibraryFont[];
  /** Plain-language reasons for any file that was not added. */
  problems: string[];
}

/** The weights a file provides: one for an ordinary font, every step in range for a variable one. */
export function weightsOf(info: Pick<FontInfo, 'weight' | 'weightRange'>): number[] {
  if (!info.weightRange) return [info.weight];
  const [min, max] = info.weightRange;
  const steps: number[] = [];
  for (let weight = 100; weight <= 900; weight += 100) if (weight >= min && weight <= max) steps.push(weight);
  return steps.length ? steps : [info.weight];
}

/** Add a parsed file to a family record, replacing any face it provides again. */
export function mergeFontFile(font: LibraryFont, file: FontFileRef, info: FontInfo): LibraryFont {
  const files = font.files.slice();
  let index = files.findIndex((f) => f.id === file.id);
  if (index < 0) index = files.push(file) - 1;
  const style = info.italic ? 'italic' : 'normal';
  const weights = weightsOf(info);
  const faces: FontFaceRecord[] = font.faces.filter((face) => !(face.style === style && weights.includes(face.weight)));
  for (const weight of weights) faces.push({ weight, style, files: [index] });
  faces.sort((a, b) => (a.style === b.style ? a.weight - b.weight : a.style === 'normal' ? -1 : 1));
  return { ...font, files, faces, embeddable: font.embeddable && mayEmbedInProject(info.embedding) };
}

export async function addFontFiles(
  inputs: readonly FontFileInput[],
  store: FontStore,
  options: { isBuiltIn?(family: string): boolean; now?: Date } = {},
): Promise<AddFontFilesResult> {
  const changed = new Map<string, LibraryFont>();
  const problems: string[] = [];
  for (const input of inputs) {
    let info: FontInfo;
    try {
      info = parseFontInfo(input.bytes);
    } catch (error) {
      problems.push(`${input.name}: ${error instanceof FontParseError ? error.message : 'This file could not be read.'}`);
      continue;
    }
    if (info.collection) {
      problems.push(`${input.name}: This file holds several fonts in one (.ttc), which cannot be added. Use a separate .ttf or .otf file for each style.`);
      continue;
    }
    if (options.isBuiltIn?.(info.family)) {
      problems.push(`${input.name}: ${info.family} is already built into the editor.`);
      continue;
    }
    const existing = changed.get(info.family) ?? (await store.getFamily(info.family));
    if (existing && existing.source !== 'file') {
      problems.push(`${input.name}: ${info.family} is already here from Google Fonts.`);
      continue;
    }
    const id = await sha256Hex(input.bytes);
    if (!(await store.hasFile(id))) await store.putFile({ id, bytes: input.bytes });
    const base: LibraryFont = existing ?? {
      family: info.family,
      source: 'file',
      embeddable: true,
      files: [],
      faces: [],
      addedAt: (options.now ?? new Date()).toISOString(),
    };
    changed.set(info.family, mergeFontFile(base, { id, bytes: input.bytes.length, format: info.format }, info));
  }
  for (const font of changed.values()) await store.putFamily(font);
  return { fonts: [...changed.values()], problems };
}

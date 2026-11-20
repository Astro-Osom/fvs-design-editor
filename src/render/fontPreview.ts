import { nearestFace } from '../document/ops';
import type { FontFileRef } from '../document/types';
import type { LibraryFont } from '../fonts/fontStore';
import { fetchGooglePreview } from '../fonts/googleDownload';
import type { LocalFamily } from '../fonts/localFonts';
import { createFontFaces } from './fonts';

/**
 * Showing a font's name in its own font, in the font list.
 *
 * Each preview is registered under a private family name, so it can never be
 * mistaken for a font a design uses. A preview that cannot be made resolves to
 * null and the name is shown in the interface font instead.
 */

const previews = new Map<string, Promise<string | null>>();
let counter = 0;

function once(key: string, make: (alias: string) => Promise<FontFace[] | null>): Promise<string | null> {
  let pending = previews.get(key);
  if (!pending) {
    const alias = `fvs-preview-${++counter}`;
    pending = make(alias)
      .then((faces) => {
        if (!faces?.length) return null;
        for (const face of faces) document.fonts.add(face);
        return alias;
      })
      .catch(() => null);
    previews.set(key, pending);
  }
  return pending;
}

/** Whether a CSS unicode-range covers ordinary Latin letters. */
export function coversBasicLatin(unicodeRange: string | undefined): boolean {
  if (!unicodeRange) return true;
  return unicodeRange.split(',').some((part) => {
    const match = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
    if (!match) return false;
    const low = Number.parseInt(match[1]!.replace(/\?/g, '0'), 16);
    const high = match[2] ? Number.parseInt(match[2], 16) : Number.parseInt(match[1]!.replace(/\?/g, 'f'), 16);
    return low <= 0x41 && high >= 0x7a;
  });
}

/** A font that is already on this machine (downloaded or added from a file). */
export function previewLibraryFont(font: LibraryFont): Promise<string | null> {
  return once(`library:${font.family}:${font.addedAt}`, async (alias) => {
    const key = nearestFace(font.faces, 400, 'normal');
    const face = key && font.faces.find((f) => f.weight === key.weight && f.style === key.style);
    if (!face) return null;
    // The name is in Latin letters, so only the files that cover them are needed.
    const latin = face.files.filter((index) => coversBasicLatin((font.files[index] as FontFileRef | undefined)?.unicodeRange));
    return createFontFaces(alias, font, { ...face, weight: 400, style: 'normal', files: latin.length ? latin : face.files });
  });
}

/** A font installed on this computer, found by name. */
export function previewLocalFamily(family: LocalFamily): Promise<string | null> {
  return once(`local:${family.family}`, async (alias) => {
    const key = nearestFace(
      family.faces.map((face) => ({ weight: face.weight, style: face.italic ? ('italic' as const) : ('normal' as const) })),
      400,
      'normal',
    );
    const face = key && family.faces.find((f) => f.weight === key.weight && f.italic === (key.style === 'italic'));
    if (!face) return null;
    return createFontFaces(alias, { files: [] }, { weight: 400, style: 'normal', files: [], localName: face.postscriptName });
  });
}

let running = 0;
const waiting: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * A Google font that has not been downloaded. This fetches a tiny sample from
 * Google, so it is only called when the person has turned previews on.
 */
export function previewGoogleFamily(family: string): Promise<string | null> {
  return once(`google:${family}`, (alias) =>
    limited(async () => {
      const bytes = await fetchGooglePreview(family);
      if (!bytes) return null;
      return [await new FontFace(alias, bytes as BufferSource, { weight: '400', style: 'normal' }).load()];
    }),
  );
}

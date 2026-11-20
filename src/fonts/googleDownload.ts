import { sha256Hex } from '../assets/assetStore';
import type { FontFaceRecord, FontFileRef } from '../document/types';
import { sniffFontFormat } from './fontInfo';
import type { FontStore, LibraryFont } from './fontStore';
import type { CatalogueFamily } from './googleCatalogue';
import { googleCssUrl, googlePreviewUrl, parseGoogleCss } from './googleCss';

/**
 * Downloading a family from Google Fonts into the font store.
 *
 * This is the only place the editor contacts another server, and it only does so
 * when the person picks a Google font. The whole family is fetched (every weight,
 * italic and group of characters) so that it keeps working with no network.
 */

export class FontDownloadError extends Error {
  constructor(
    message: string,
    readonly code: 'offline' | 'not-found' | 'bad-response' | 'cancelled' | 'storage',
  ) {
    super(message);
    this.name = 'FontDownloadError';
  }
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Called as files arrive: how many are done, out of how many. */
  onProgress?(done: number, total: number): void;
  fetch?: typeof fetch;
  now?: Date;
}

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const PARALLEL = 6;

function cancelled(): FontDownloadError {
  return new FontDownloadError('The download was cancelled.', 'cancelled');
}

async function get(url: string, family: string, options: DownloadOptions): Promise<Response> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { signal: options.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    throw new FontDownloadError(
      `Google Fonts could not be reached, so ${family} was not downloaded. Check your internet connection and try again.`,
      'offline',
    );
  }
  if (response.status === 400 || response.status === 404) {
    throw new FontDownloadError(`Google Fonts does not offer ${family} any more.`, 'not-found');
  }
  if (!response.ok) {
    throw new FontDownloadError(`Google Fonts answered with an error (${response.status}), so ${family} was not downloaded.`, 'bad-response');
  }
  return response;
}

export async function downloadGoogleFamily(entry: CatalogueFamily, store: FontStore, options: DownloadOptions = {}): Promise<LibraryFont> {
  const { family } = entry;
  const css = await (await get(googleCssUrl(family, entry.weights, entry.italics), family, options)).text();
  const rules = parseGoogleCss(css).filter((rule) => rule.family.toLowerCase() === family.toLowerCase());
  if (!rules.length) {
    throw new FontDownloadError(`Google Fonts sent something unexpected for ${family}, so it was not downloaded.`, 'bad-response');
  }

  const urls = [...new Set(rules.map((rule) => rule.url))];
  const fileByUrl = new Map<string, FontFileRef>();
  let done = 0;
  options.onProgress?.(0, urls.length);
  const queue = urls.slice();
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      if (options.signal?.aborted) throw cancelled();
      const bytes = new Uint8Array(await (await get(url, family, options)).arrayBuffer());
      const format = sniffFontFormat(bytes);
      if (!format || format === 'ttc' || bytes.length > MAX_FILE_BYTES) {
        throw new FontDownloadError(`Google Fonts sent something that is not a font for ${family}, so it was not downloaded.`, 'bad-response');
      }
      const id = await sha256Hex(bytes);
      try {
        if (!(await store.hasFile(id))) await store.putFile({ id, bytes });
      } catch {
        throw new FontDownloadError(`There is not enough storage space on this computer to keep ${family}.`, 'storage');
      }
      const rule = rules.find((r) => r.url === url)!;
      const file: FontFileRef = { id, bytes: bytes.length, format };
      if (rule.unicodeRange) file.unicodeRange = rule.unicodeRange;
      fileByUrl.set(url, file);
      options.onProgress?.(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, urls.length) }, worker));
  if (options.signal?.aborted) throw cancelled();

  // Two addresses can hold the same bytes; keep each file once.
  const files: FontFileRef[] = [];
  const indexById = new Map<string, number>();
  const indexOf = (url: string): number => {
    const file = fileByUrl.get(url)!;
    let index = indexById.get(file.id);
    if (index === undefined) {
      index = files.push(file) - 1;
      indexById.set(file.id, index);
    }
    return index;
  };
  const faces = new Map<string, FontFaceRecord>();
  for (const rule of rules) {
    const key = `${rule.style}|${rule.weight}`;
    let face = faces.get(key);
    if (!face) faces.set(key, (face = { weight: rule.weight, style: rule.style, files: [] }));
    const index = indexOf(rule.url);
    if (!face.files.includes(index)) face.files.push(index);
  }

  const font: LibraryFont = {
    family,
    source: 'google',
    license: entry.license,
    embeddable: true,
    files,
    faces: [...faces.values()].sort((a, b) => (a.style === b.style ? a.weight - b.weight : a.style === 'normal' ? -1 : 1)),
    addedAt: (options.now ?? new Date()).toISOString(),
  };
  try {
    await store.putFamily(font);
  } catch {
    throw new FontDownloadError(`There is not enough storage space on this computer to keep ${family}.`, 'storage');
  }
  return font;
}

/**
 * Fetch a tiny sample of a family that contains only the letters of its own name,
 * to show the name in its own font before the family is downloaded.
 */
export async function fetchGooglePreview(family: string, options: Pick<DownloadOptions, 'signal' | 'fetch'> = {}): Promise<Uint8Array | null> {
  try {
    const css = await (await get(googlePreviewUrl(family, family), family, options)).text();
    const rule = parseGoogleCss(css)[0];
    if (!rule) return null;
    const bytes = new Uint8Array(await (await get(rule.url, family, options)).arrayBuffer());
    return sniffFontFormat(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

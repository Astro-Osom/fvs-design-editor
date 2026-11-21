import { cache } from 'fabric';
import { documentFont, type FaceKey } from '../document/ops';
import type { DesignDocument, DocumentFont, FontFaceRecord, FontUse } from '../document/types';

// Built-in fonts. They ship inside the app, so text works with no network.
import '@fontsource/inter/400.css';
import '@fontsource/inter/400-italic.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/600-italic.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/800-italic.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/400-italic.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/600-italic.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/800-italic.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/400-italic.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/600-italic.css';
import '@fontsource/poppins/800.css';
import '@fontsource/poppins/800-italic.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';

/**
 * Fonts, as the renderer sees them.
 *
 * A family is either built in (below) or listed in the design's own `fonts`
 * table, which pins the exact font files by hash or names a font installed on
 * the computer. Either way, every face is fully loaded before any text is
 * measured, and a face that cannot be loaded is reported, never swapped silently.
 */

export interface BundledFont {
  family: string;
  /** Weights that really exist as font files. Nothing else is offered, so nothing is faked. */
  weights: number[];
  italic: boolean;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'Inter', weights: [400, 600, 800], italic: true },
  { family: 'Montserrat', weights: [400, 600, 800], italic: true },
  { family: 'Poppins', weights: [400, 600, 800], italic: true },
  { family: 'Anton', weights: [400], italic: false },
  { family: 'Bebas Neue', weights: [400], italic: false },
];

export const WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin',
  200: 'Extra light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra bold',
  900: 'Black',
};

export function findBundledFont(family: string): BundledFont | undefined {
  return BUNDLED_FONTS.find((f) => f.family === family);
}

export function isBundledFamily(family: string): boolean {
  return !!findBundledFont(family);
}

function bundledFaces(font: BundledFont): FaceKey[] {
  const faces: FaceKey[] = font.weights.map((weight) => ({ weight, style: 'normal' }));
  if (font.italic) for (const weight of font.weights) faces.push({ weight, style: 'italic' });
  return faces;
}

/**
 * The styles a family really has in this design: built-in families first, then
 * the design's own font table. Empty when the family is unknown.
 */
export function availableFaces(doc: Pick<DesignDocument, 'fonts'>, family: string): FaceKey[] {
  const bundled = findBundledFont(family);
  if (bundled) return bundledFaces(bundled);
  return (documentFont(doc as DesignDocument, family)?.faces ?? []).map((face) => ({ weight: face.weight, style: face.style }));
}

export interface FontRequest extends FontUse {
  /** The text that will be drawn, so the right character subsets are loaded. */
  sample: string;
}

export function fontRequestsFor(doc: DesignDocument): FontRequest[] {
  const byKey = new Map<string, FontRequest>();
  for (const page of doc.pages) {
    for (const node of page.nodes) {
      if (node.type !== 'text') continue;
      const key = `${node.fontFamily}|${node.fontWeight}|${node.fontStyle}`;
      const existing = byKey.get(key);
      if (existing) existing.sample += node.text;
      else {
        byKey.set(key, {
          family: node.fontFamily,
          weight: node.fontWeight,
          style: node.fontStyle,
          sample: node.text || 'A',
        });
      }
    }
  }
  return [...byKey.values()];
}

// ------------------------------------------------------- font file source

/** Where font file bytes come from. Set once at start-up (see state/services.ts). */
export interface FontFileSource {
  getFile(id: string): Promise<{ bytes: Uint8Array } | undefined>;
}

let fontFiles: FontFileSource | null = null;

export function setFontFileSource(source: FontFileSource | null): void {
  fontFiles = source;
}

// ------------------------------------------------------------- registry

interface RegisteredFamily {
  /** Identifies the exact files and names this family was registered from. */
  signature: string;
  faces: Map<string, { loading: Promise<FontFace[] | null>; done: boolean }>;
}

const registered = new Map<string, RegisteredFamily>();

function signatureOf(font: DocumentFont): string {
  return JSON.stringify([font.source, font.files.map((f) => f.id), font.faces.map((f) => [f.weight, f.style, f.files, f.localName ?? ''])]);
}

function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/** Build and fully load the browser font faces for one face of a family. Null if it cannot be loaded. */
export async function createFontFaces(family: string, font: Pick<DocumentFont, 'files'>, face: FontFaceRecord): Promise<FontFace[] | null> {
  const descriptors = { weight: String(face.weight), style: face.style };
  try {
    if (face.files.length) {
      if (!fontFiles) return null;
      const faces: FontFace[] = [];
      for (const index of face.files) {
        const ref = font.files[index];
        const stored = ref ? await fontFiles.getFile(ref.id) : undefined;
        if (!ref || !stored) return null;
        const fontFace = new FontFace(family, stored.bytes as BufferSource, ref.unicodeRange ? { ...descriptors, unicodeRange: ref.unicodeRange } : descriptors);
        faces.push(await fontFace.load());
      }
      return faces;
    }
    if (face.localName) {
      // A font installed on this computer, found by its exact name. Loading fails if it is not installed.
      return [await new FontFace(family, `local(${cssString(face.localName)})`, descriptors).load()];
    }
  } catch {
    return null;
  }
  return null;
}

function unregister(family: string): void {
  const entry = registered.get(family);
  if (!entry) return;
  registered.delete(family);
  for (const pending of entry.faces.values()) {
    void pending.loading.then((faces) => faces?.forEach((face) => document.fonts.delete(face)));
  }
}

/** Forget what was registered for a family, so it is loaded afresh next time (after its files arrive, say). */
export function forgetFontFamily(family: string): void {
  unregister(family);
  cache.clearFontCache(family);
}

async function ensureFace(font: DocumentFont, face: FontFaceRecord, changed: Set<string>): Promise<boolean> {
  const signature = signatureOf(font);
  let entry = registered.get(font.family);
  if (!entry || entry.signature !== signature) {
    // A different design may pin different files for the same family name.
    unregister(font.family);
    entry = { signature, faces: new Map() };
    registered.set(font.family, entry);
    changed.add(font.family);
  }
  const key = `${face.weight}|${face.style}`;
  let pending = entry.faces.get(key);
  if (!pending) {
    const owner = entry;
    const started = { done: false } as { loading: Promise<FontFace[] | null>; done: boolean };
    started.loading = createFontFaces(font.family, font, face).then((faces) => {
      if (!faces) {
        // Do not remember a failure: the files may arrive later.
        owner.faces.delete(key);
        return null;
      }
      if (registered.get(font.family) === owner) for (const fontFace of faces) document.fonts.add(fontFace);
      started.done = true;
      return faces;
    });
    entry.faces.set(key, (pending = started));
  }
  // Anyone who had to wait for this face must lay its text out again.
  const waited = !pending.done;
  const loaded = (await pending.loading) !== null;
  if (loaded && waited) changed.add(font.family);
  return loaded;
}

const loadedBundled = new Set<string>();

async function ensureBundled(request: FontRequest, font: BundledFont, changed: Set<string>): Promise<boolean> {
  if (!font.weights.includes(request.weight) || (request.style === 'italic' && !font.italic)) return false;
  const key = `${request.family}|${request.weight}|${request.style}|${[...new Set(request.sample)].sort().join('')}`;
  if (loadedBundled.has(key)) return true;
  try {
    const faces = await document.fonts.load(`${request.style} ${request.weight} 32px "${request.family}"`, request.sample);
    if (faces.length === 0) return false;
    loadedBundled.add(key);
    changed.add(request.family);
    return true;
  } catch {
    return false;
  }
}

export interface FontLoadResult {
  /** Faces that are not available. Text using them is drawn in a fallback. */
  missing: FontUse[];
  /** Families whose font data arrived or changed, so text using them must be laid out again. */
  changed: Set<string>;
}

/**
 * Make sure every requested font face has finished loading before text is laid out.
 * Callers must show `missing` to the person: text in a missing font is drawn in a
 * fallback, never silently.
 */
export async function loadFontsDetailed(doc: Pick<DesignDocument, 'fonts'>, requests: readonly FontRequest[]): Promise<FontLoadResult> {
  const missing: FontUse[] = [];
  const changed = new Set<string>();
  await Promise.all(
    requests.map(async (request) => {
      const use: FontUse = { family: request.family, weight: request.weight, style: request.style };
      const bundled = findBundledFont(request.family);
      let ok = false;
      if (bundled) ok = await ensureBundled(request, bundled, changed);
      else {
        const font = documentFont(doc as DesignDocument, request.family);
        const face = font?.faces.find((f) => f.weight === request.weight && f.style === request.style);
        if (font && face) ok = await ensureFace(font, face, changed);
      }
      if (!ok) missing.push(use);
    }),
  );
  // Fabric caches glyph widths per family; measurements made before the real font
  // arrived would give wrong line breaks.
  for (const family of changed) cache.clearFontCache(family);
  return { missing, changed };
}

export async function loadFonts(doc: Pick<DesignDocument, 'fonts'>, requests: readonly FontRequest[]): Promise<FontUse[]> {
  return (await loadFontsDetailed(doc, requests)).missing;
}

export function loadFontsForDocument(doc: DesignDocument): Promise<FontUse[]> {
  return loadFonts(doc, fontRequestsFor(doc));
}

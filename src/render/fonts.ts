import { cache } from 'fabric';
import type { DesignDocument, FontUse } from '../document/types';

// Bundled fonts. They ship inside the app, so text works with no network.
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

export const WEIGHT_LABELS: Record<number, string> = { 400: 'Regular', 600: 'Semibold', 800: 'Extra bold' };

export function findBundledFont(family: string): BundledFont | undefined {
  return BUNDLED_FONTS.find((f) => f.family === family);
}

export function isFontAvailable(use: FontUse): boolean {
  const font = findBundledFont(use.family);
  if (!font) return false;
  if (!font.weights.includes(use.weight)) return false;
  return use.style === 'normal' || font.italic;
}

/** The closest weight a family really has, used when switching family. */
export function nearestWeight(family: string, weight: number): number {
  const font = findBundledFont(family);
  if (!font) return weight;
  return font.weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best));
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

const loadedKeys = new Set<string>();

/**
 * Make sure every requested font face has finished loading before text is laid out.
 * Returns the fonts that are not available. Callers must show those to the person:
 * text in a missing font is drawn in a fallback, never silently.
 */
export async function loadFonts(requests: readonly FontRequest[]): Promise<FontUse[]> {
  const missing: FontUse[] = [];
  const changedFamilies = new Set<string>();
  await Promise.all(
    requests.map(async (request) => {
      const use: FontUse = { family: request.family, weight: request.weight, style: request.style };
      if (!isFontAvailable(use)) {
        missing.push(use);
        return;
      }
      const key = `${request.family}|${request.weight}|${request.style}|${[...new Set(request.sample)].sort().join('')}`;
      if (loadedKeys.has(key)) return;
      try {
        const faces = await document.fonts.load(
          `${request.style} ${request.weight} 32px "${request.family}"`,
          request.sample,
        );
        if (faces.length === 0) {
          missing.push(use);
          return;
        }
        loadedKeys.add(key);
        changedFamilies.add(request.family);
      } catch {
        missing.push(use);
      }
    }),
  );
  // Fabric caches glyph widths per family; measurements made before the real font
  // arrived would give wrong line breaks.
  for (const family of changedFamilies) cache.clearFontCache(family);
  return missing;
}

export function loadFontsForDocument(doc: DesignDocument): Promise<FontUse[]> {
  return loadFonts(fontRequestsFor(doc));
}

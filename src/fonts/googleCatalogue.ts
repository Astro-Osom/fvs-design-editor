/**
 * The list of Google Fonts families the editor can offer.
 *
 * The list (names and available styles, about 55 KB) ships with the app, so
 * browsing and searching work with no network. Font files are only downloaded
 * when a family is used. Regenerate the list with
 * `node scripts/update-google-fonts-catalogue.mjs`.
 */

export type GoogleCategory = 'Sans Serif' | 'Serif' | 'Display' | 'Handwriting' | 'Monospace';

export interface CatalogueFamily {
  family: string;
  category: GoogleCategory;
  /** Upright weights that exist. */
  weights: number[];
  /** Italic weights that exist. */
  italics: number[];
  /** OFL-1.1, Apache-2.0 or UFL-1.0. All three allow redistribution and embedding. */
  license: string;
  /** Families covering Chinese, Japanese or Korean: their downloads are much larger. */
  large: boolean;
  /** Position in Google's popularity order, starting at 0. */
  rank: number;
}

interface RawCatalogue {
  generatedAt: string;
  categories: GoogleCategory[];
  licenses: string[];
  families: [string, number, number, number, number, number][];
}

function weightsFromMask(mask: number): number[] {
  const weights: number[] = [];
  for (let i = 0; i < 9; i++) if (mask & (1 << i)) weights.push((i + 1) * 100);
  return weights;
}

export function decodeCatalogue(raw: RawCatalogue): CatalogueFamily[] {
  return raw.families.map(([family, category, normal, italic, license, large], rank) => ({
    family,
    category: raw.categories[category] ?? 'Sans Serif',
    weights: weightsFromMask(normal),
    italics: weightsFromMask(italic),
    license: raw.licenses[license] ?? 'OFL-1.1',
    large: large === 1,
    rank,
  }));
}

let loaded: Promise<CatalogueFamily[]> | null = null;

/** The catalogue, loaded on first use so it does not slow down starting the app. */
export function loadGoogleCatalogue(): Promise<CatalogueFamily[]> {
  loaded ??= import('./google-catalogue.json').then((module) => decodeCatalogue(module.default as unknown as RawCatalogue));
  return loaded;
}

export async function findGoogleFamily(family: string): Promise<CatalogueFamily | undefined> {
  const wanted = family.toLowerCase();
  return (await loadGoogleCatalogue()).find((entry) => entry.family.toLowerCase() === wanted);
}

/**
 * Filter by what was typed and by category, keeping popularity order. Names that
 * start with the search text come before names that only contain it.
 */
export function searchFamilies<T extends { family: string }>(families: readonly T[], query: string): T[] {
  const text = query.trim().toLowerCase();
  if (!text) return families.slice();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const entry of families) {
    const name = entry.family.toLowerCase();
    if (name.startsWith(text)) starts.push(entry);
    else if (name.includes(text)) contains.push(entry);
  }
  return [...starts, ...contains];
}

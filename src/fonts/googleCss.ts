import type { FontFormat } from '../document/types';

/**
 * Talking to Google Fonts' stylesheet service (https://fonts.googleapis.com/css2).
 *
 * The service needs no key. For a family it returns `@font-face` rules that name
 * the font files on fonts.gstatic.com, one per style and per group of characters.
 * See docs/research/fonts.md.
 */

export const GOOGLE_CSS_ORIGIN = 'https://fonts.googleapis.com';
export const GOOGLE_FILES_ORIGIN = 'https://fonts.gstatic.com';

export interface GoogleFaceRule {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  url: string;
  format: FontFormat;
  unicodeRange?: string;
}

/** The address that lists every requested style of a family. */
export function googleCssUrl(family: string, normalWeights: readonly number[], italicWeights: readonly number[]): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  const normal = [...normalWeights].sort((a, b) => a - b);
  const italic = [...italicWeights].sort((a, b) => a - b);
  let spec = '';
  if (italic.length) {
    // Tuples must be sorted: all upright weights, then all italic weights.
    spec = `:ital,wght@${[...normal.map((w) => `0,${w}`), ...italic.map((w) => `1,${w}`)].join(';')}`;
  } else if (normal.length > 1 || normal[0] !== 400) {
    spec = `:wght@${normal.join(';')}`;
  }
  return `${GOOGLE_CSS_ORIGIN}/css2?family=${name}${spec}`;
}

/** The address for a tiny sample of a family that only contains the letters of `text`. */
export function googlePreviewUrl(family: string, text: string): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  return `${GOOGLE_CSS_ORIGIN}/css2?family=${name}&text=${encodeURIComponent(text)}`;
}

const FORMATS: Record<string, FontFormat> = { woff2: 'woff2', woff: 'woff', truetype: 'ttf', opentype: 'otf' };

function declaration(block: string, property: string): string | null {
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'i').exec(block);
  return match ? match[1]!.trim() : null;
}

/**
 * Read the `@font-face` rules out of a stylesheet from the service.
 * Rules that do not point at Google's font file host are ignored, so a changed
 * or tampered response cannot make the editor fetch from somewhere else.
 */
export function parseGoogleCss(css: string): GoogleFaceRule[] {
  const rules: GoogleFaceRule[] = [];
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  for (const block of blocks) {
    const family = declaration(block, 'font-family')?.replace(/^['"]|['"]$/g, '');
    const src = declaration(block, 'src');
    const source = src ? /url\(\s*['"]?([^'")\s]+)['"]?\s*\)(?:\s*format\(\s*['"]?([a-z0-9-]+)['"]?\s*\))?/i.exec(src) : null;
    if (!family || !source) continue;
    const url = source[1]!;
    if (!url.startsWith(`${GOOGLE_FILES_ORIGIN}/`)) continue;
    const format = FORMATS[(source[2] ?? '').toLowerCase()] ?? (/\.woff2(\?|$)/.test(url) ? 'woff2' : /\.woff(\?|$)/.test(url) ? 'woff' : /\.otf(\?|$)/.test(url) ? 'otf' : 'ttf');
    const weight = Number.parseInt(declaration(block, 'font-weight') ?? '400', 10);
    const rule: GoogleFaceRule = {
      family,
      weight: Number.isFinite(weight) ? weight : 400,
      style: /italic|oblique/i.test(declaration(block, 'font-style') ?? '') ? 'italic' : 'normal',
      url,
      format,
    };
    const range = declaration(block, 'unicode-range');
    if (range) rule.unicodeRange = range.replace(/\s+/g, ' ');
    rules.push(rule);
  }
  return rules;
}

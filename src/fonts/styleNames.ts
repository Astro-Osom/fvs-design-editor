/**
 * Reading weight and italic out of style names such as "Condensed ExtraBold Oblique".
 * Font files and operating systems describe styles in words; the editor works with
 * a weight number (400 is regular, 700 is bold) and an italic flag.
 */

const ITALIC_WORDS = new Set(['italic', 'oblique', 'slanted', 'inclined', 'ita', 'it']);
const WEIGHT_WORDS: Record<string, number> = {
  hairline: 100,
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  roman: 400,
  plain: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  demi: 600,
  semi: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  heavy: 800,
  black: 900,
  extrablack: 900,
  ultrablack: 900,
};
const PREFIXES = new Set(['extra', 'ultra', 'semi', 'demi']);
// Some fonts name their weights with one or two letters.
const LETTER_WEIGHTS: Record<string, number> = { ul: 100, el: 200, l: 300, r: 400, m: 500, db: 600, b: 700, eb: 800, h: 900 };

/**
 * Work out weight and italic from a style name such as "Condensed ExtraBold Oblique".
 * `rest` is whatever is left ("Condensed"): it names a different design, so it
 * becomes part of the family name.
 */
export function guessStyle(styleName: string): { weight: number; italic: boolean; rest: string } {
  const words = styleName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  let weight: number | null = null;
  let italic = false;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const lower = word.toLowerCase();
    const joined = PREFIXES.has(lower) && words[i + 1] ? lower + words[i + 1]!.toLowerCase() : '';
    const numbered = /^w(\d)$/.exec(lower);
    if (ITALIC_WORDS.has(lower)) italic = true;
    else if (joined && WEIGHT_WORDS[joined] !== undefined) {
      weight ??= WEIGHT_WORDS[joined]!;
      i++;
    } else if (WEIGHT_WORDS[lower] !== undefined) weight ??= WEIGHT_WORDS[lower]!;
    else if (numbered) weight ??= Math.max(1, Number(numbered[1])) * 100;
    else if (words.length === 1 && LETTER_WEIGHTS[lower] !== undefined) weight = LETTER_WEIGHTS[lower]!;
    else rest.push(word);
  }
  return { weight: weight ?? 400, italic, rest: rest.join(' ') };
}

/**
 * Some font files put the weight in the family name ("Inter ExtraBold") instead of
 * naming the family and the style separately. When the trailing words say exactly
 * the weight the font reports, drop them, so every weight lands in one family.
 */
export function stripWeightFromFamily(family: string, weight: number): string {
  const words = family.trim().split(/\s+/);
  for (const take of [2, 1]) {
    if (words.length <= take) continue;
    const named = WEIGHT_WORDS[words.slice(-take).join('').toLowerCase()];
    if (named !== undefined && named === Math.round(weight / 100) * 100) return words.slice(0, -take).join(' ');
  }
  return family;
}

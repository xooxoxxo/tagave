/**
 * Text normalization and string distance functions for album matching.
 * Following spec §12.5: Unicode NFKC, case folding, punctuation stripping,
 * leading-article insensitivity, Jaro-Winkler and token-set ratio distances.
 *
 * Letters, digits and combining marks are kept in every script, so Japanese,
 * Chinese, Cyrillic or accented Latin titles are compared rather than
 * deleted. NFKC folds full-width and other compatibility forms ("Ｍ" → "M").
 *
 * Accents are folded on Latin letters only ("é" → "e", "ő" → "o"): tags and
 * catalogues disagree about them all the time ("Regö" against "Regő"). A
 * mark on a letter of any other script is kept, because there it tells
 * words apart: a Japanese voiced mark makes "が" a different kana from "か",
 * and the breve makes "й" a different Cyrillic letter from "и".
 */

/**
 * Signs that NFKC would turn into letters or into a space plus an accent:
 * "™" becomes "TM", "´" becomes " ́" and splits "Journey´s" in two. They are
 * removed before the fold. The spacing kana voiced marks stay, so the fold
 * can still attach them to their kana.
 */
const PRE_FOLD_SIGNS = /[\u2120\u2122]|(?![\u309B\u309C])\p{Sk}/gu;

/** Latin letters with no decomposition into a base letter and a mark. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  'ø': 'o', 'ł': 'l', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ƒ': 'f',
  // Turkish dotless i; its capital is "I", and the dotted capital "İ" decomposes into I + dot
  'ı': 'i',
};
const LATIN_LETTER = new RegExp(`[${Object.keys(LATIN_LETTERS).join('')}]`, 'gu');

/** Combining marks that sit on a Latin letter. */
const LATIN_MARKS = /(\p{Script=Latin})\p{M}+/gu;

/**
 * The shared first step: compatibility fold, lowercase, and Latin accents
 * folded. Marks on every other script are kept and recomposed.
 */
function fold(s: string): string {
  return s
    .replace(PRE_FOLD_SIGNS, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LATIN_LETTER, (ch) => LATIN_LETTERS[ch] ?? ch)
    .normalize('NFKD')
    .replace(LATIN_MARKS, '$1')
    .normalize('NFC');
}

/** Emoji variation selectors and the keycap mark carry no text. */
const EMOJI_MARKS = /[\uFE00-\uFE0F\u20E3\u{E0100}-\u{E01EF}]/gu;
/** A combining mark with no letter or digit to sit on (left behind by a stripped symbol). */
const ORPHAN_MARKS = /(^|[^\p{L}\p{N}\p{M}])\p{M}+/gu;
/** Anything that is not a letter, digit, combining mark or space. */
const NON_TEXT = /[^\p{L}\p{N}\p{M}\s]/gu;

/**
 * Normalize a string for comparison: NFKC + lowercase + punctuation removal + leading article removal.
 * Matches spec §12.5 normalization rules.
 */
export function normalizeString(s: string): string {
  if (!s) return '';

  // Unicode NFKC (compatibility composed form) and lowercase
  let normalized = fold(s);

  // Remove punctuation, symbols and emoji; keep letters, digits and marks in every script
  normalized = normalized.replace(EMOJI_MARKS, '').replace(ORPHAN_MARKS, '$1').replace(NON_TEXT, '').trim();

  // Collapse multiple spaces into one
  normalized = normalized.replace(/\s+/g, ' ');

  // Remove leading articles ("the", "a", "an")
  normalized = normalized.replace(/^(the|a|an)\s+/i, '').trim();

  return normalized;
}

/**
 * Normalize title specifically (same as normalizeString but used in matching for clarity).
 */
export function normalizeTitle(s: string): string {
  return normalizeString(s);
}

/**
 * Case-insensitive, punctuation-insensitive comparison.
 */
export function compareStrings(a: string, b: string): boolean {
  return normalizeString(a) === normalizeString(b);
}

/**
 * Jaro-Winkler distance: measures similarity of two strings.
 * Returns a value between 0 and 1, where 1 is identical and 0 is completely different.
 * Uses prefix weighting (up to 4 characters) for names/titles.
 *
 * Algorithm: https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance
 */
export function jaroWinklerDistance(a: string, b: string): number {
  const s1 = fold(a);
  const s2 = fold(b);

  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchDistance = Math.max(len1, len2) / 2 - 1;

  const s1Matches = new Array(len1);
  const s2Matches = new Array(len2);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  // Jaro similarity
  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) /
    3;

  // Jaro-Winkler: add bonus for common prefix (up to 4 chars)
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }

  const scalingFactor = 0.1;
  return jaro + prefixLen * scalingFactor * (1 - jaro);
}

/**
 * Token-set ratio: splits strings into tokens and compares the sorted sets.
 * More tolerant of word order differences than Jaro-Winkler.
 * Returns a value between 0 and 1.
 */
export function tokenSetRatio(a: string, b: string): number {
  const s1 = fold(a);
  const s2 = fold(b);

  if (s1 === s2) return 1;

  // Split into tokens and remove duplicates, normalize each token
  const tokenize = (s: string) => {
    const tokens = s.split(/\s+/);
    return [...new Set(tokens.filter((t) => t.length > 0))].sort();
  };

  const tokens1 = tokenize(s1);
  const tokens2 = tokenize(s2);

  // Intersection and union of tokens
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = tokens1.filter((t) => set2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  if (union === 0) return 0;
  return intersection / union;
}

/** Distance between two already normalized strings. */
function normalizedDistance(normalized1: string, normalized2: string): number {
  if (normalized1 === normalized2) return 0;
  if (!normalized1 || !normalized2) return 1;

  // Jaro-Winkler returns similarity (1 = match), convert to distance
  const jw = 1 - jaroWinklerDistance(normalized1, normalized2);

  // Token-set ratio also returns similarity, convert to distance
  const tokenSet = 1 - tokenSetRatio(normalized1, normalized2);

  // Weighted average: slightly favor Jaro-Winkler for single-word differences
  return jw * 0.6 + tokenSet * 0.4;
}

/**
 * Combined string distance for matching: weighted average of normalized Jaro-Winkler
 * and token-set ratio. Lower values indicate better matches.
 *
 * Distance is 1 - similarity, so a return of 0 means identical and 1 means completely different.
 * Used for album titles, artist names, etc.
 */
export function stringDistance(a: string, b: string): number {
  return normalizedDistance(normalizeString(a), normalizeString(b));
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

type ScriptFamily = 'latin' | 'cyrillic' | 'greek' | 'cjk' | 'arabic' | 'hebrew' | 'other';

/**
 * Letters by writing system. Han, kana, Hangul and Bopomofo are one family,
 * because Japanese titles mix kanji and kana and a Korean one may carry
 * hanja; by Script_Extensions, so the kana long-vowel mark counts as kana.
 * Letters of any script not named here are one "other" family, so two such
 * texts always compare.
 */
const FAMILY_LETTERS: ReadonlyArray<readonly [Exclude<ScriptFamily, 'other'>, string]> = [
  ['latin', '\\p{sc=Latin}'],
  ['cyrillic', '\\p{sc=Cyrillic}'],
  ['greek', '\\p{sc=Greek}'],
  ['cjk', '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{scx=Bopomofo}'],
  ['arabic', '\\p{sc=Arabic}'],
  ['hebrew', '\\p{sc=Hebrew}'],
];
const KNOWN_LETTERS = FAMILY_LETTERS.map(([, cls]) => cls).join('');
/** One letter of a family, with the marks that sit on it. */
const FAMILY_LETTER: Readonly<Record<ScriptFamily, RegExp>> = {
  ...Object.fromEntries(FAMILY_LETTERS.map(([f, cls]) => [f, new RegExp(`[${cls}]\\p{M}*`, 'gu')])),
  other: new RegExp(`(?![${KNOWN_LETTERS}])\\p{L}\\p{M}*`, 'gu'),
} as Record<ScriptFamily, RegExp>;
const FAMILIES = Object.keys(FAMILY_LETTER) as ScriptFamily[];

/** The script families whose letters a text uses. */
function familiesOf(s: string): Set<ScriptFamily> {
  const out = new Set<ScriptFamily>();
  for (const f of FAMILIES) {
    const re = FAMILY_LETTER[f];
    re.lastIndex = 0;
    if (re.test(s)) out.add(f);
  }
  return out;
}

/** The text without the letters of the given families, spaces collapsed. */
function withoutFamilies(s: string, drop: ScriptFamily[]): string {
  let out = s;
  for (const f of drop) out = out.replace(FAMILY_LETTER[f], '');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * What the old normaliser kept of a text: ASCII letters, digits, underscore
 * and spaces, without a leading English article. A Cyrillic or Japanese
 * title, or one read with the wrong code page, keeps nothing.
 */
function asciiSkeleton(s: string): string {
  return s.normalize('NFC').toLowerCase()
    .replace(/[^\w\s]/gu, '').trim()
    .replace(/\s+/g, ' ')
    .replace(/^(the|a|an)\s+/i, '').trim();
}

/**
 * The distance the matcher uses: stringDistance over the scripts both texts
 * are written in. A part in a script the other text does not use says
 * nothing about it, so it neither adds to nor takes away from the match:
 * the Arabic half of "تانيا صالح = Tania Saleh" against "Tania Saleh", or
 * the Greek of "Πρόλογος (Prologos)" against "Prologos".
 *
 * - Both texts use the same scripts: compared as they are, so two different
 *   Japanese titles stay apart.
 * - They share some scripts: only the letters of those are compared.
 * - They share none (both have letters): there is nothing to compare, and
 *   the pair is judged exactly as the old normaliser judged it, by the
 *   plain ASCII letters and digits each carries. Two texts with none (a
 *   Cyrillic title against the same title read with the wrong code page)
 *   cost nothing; a plain-ASCII name against a Cyrillic one costs what it
 *   always did. Durations and the other fields decide the rest.
 * - A text without letters (only digits, or empty) compares as it is.
 */
export function scriptAwareDistance(a: string, b: string): number {
  const n1 = normalizeString(a);
  const n2 = normalizeString(b);
  if (n1 === n2) return 0;
  const f1 = familiesOf(n1);
  const f2 = familiesOf(n2);
  if (f1.size === 0 || f2.size === 0) return normalizedDistance(n1, n2);
  const only1 = [...f1].filter((f) => !f2.has(f));
  const only2 = [...f2].filter((f) => !f1.has(f));
  if (only1.length === f1.size) return normalizedDistance(asciiSkeleton(a), asciiSkeleton(b));
  return normalizedDistance(withoutFamilies(n1, only1), withoutFamilies(n2, only2));
}

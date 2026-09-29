/**
 * How the artists list shows, groups and orders names that come straight from
 * tags. Display and sort only: nothing here changes a tag or a stored name.
 *
 * Tags carry junk: C1 control bytes from a bad encoding ("\u008F\u008E¬}"),
 * zero-width marks, block glyphs that render as a solid box ("██████"), or a
 * name that is only punctuation ("+/-"). Those must never render as an empty
 * box, and they file after real names under "#". Names in other scripts
 * (이지수, Сплин) are real names and keep their own group.
 */

export const UNKNOWN_ARTIST = 'Unknown artist';

/**
 * Characters that never belong in a displayed name: control (Cc), format and
 * zero-width (Cf), private use (Co), unassigned (Cn), line/paragraph
 * separators, the replacement and object-replacement characters, and the
 * block-element glyphs (U+2580–U+259F) that show as solid boxes.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}▀-▟￼�]/gu;
const SPACES = /\s+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LEADING_ARTICLE = /^the\s+(?=\S)/iu;

/** Latin letters NFD does not decompose into a base letter. */
const LATIN_FOLD: Record<string, string> = {
  'ø': 'o', 'æ': 'a', 'œ': 'o', 'ß': 's', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 't', 'ı': 'i', 'ħ': 'h',
};

/** A name with invisible and box characters removed and spaces collapsed. May be empty. */
export function cleanArtistName(name: string | null | undefined): string {
  if (!name) return '';
  return name.normalize('NFC').replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}

/** The name to show: cleaned, or "Unknown artist" when nothing visible is left. */
export function artistLabel(name: string | null | undefined): string {
  return cleanArtistName(name) || UNKNOWN_ARTIST;
}

/** True when a name has no letter or digit at all (blank, symbols, punctuation). */
export function isSymbolOnlyName(name: string | null | undefined): boolean {
  return !WORD_CHAR.test(cleanArtistName(name));
}

/**
 * Group keys, in list order: "A" … "Z", "0-9", "other" (letters of other
 * scripts), "#" (symbols, punctuation, blank). Letters lead: in a real
 * library most names starting with a digit are rip leftovers ("01",
 * "00.db"), so they follow the alphabet instead of opening the list.
 */
export type ArtistGroupKey = string;
export const ARTIST_GROUP_ORDER: readonly ArtistGroupKey[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), '0-9', 'other', '#',
];
const GROUP_RANK = new Map(ARTIST_GROUP_ORDER.map((key, index) => [key, index]));

export function artistGroupLabel(key: ArtistGroupKey): string {
  if (key === 'other') return 'Other scripts';
  if (key === '#') return 'Symbols & unknown';
  return key;
}

/**
 * The text a name files under: the sort name when MusicBrainz gave one
 * ("Beatles, The"), otherwise the cleaned name without a leading "The ".
 */
export function artistSortText(name: string | null | undefined, sortName?: string | null): string {
  const fromSort = cleanArtistName(sortName);
  if (fromSort && WORD_CHAR.test(fromSort)) return fromSort;
  return cleanArtistName(name).replace(LEADING_ARTICLE, '');
}

/** The group a name files under. */
export function artistGroup(name: string | null | undefined, sortName?: string | null): ArtistGroupKey {
  const text = artistSortText(name, sortName);
  const first = [...text].find((ch) => WORD_CHAR.test(ch));
  if (!first) return '#';
  if (/\p{N}/u.test(first)) return '0-9';
  const lower = first.toLowerCase();
  const base = (LATIN_FOLD[lower] ?? lower.normalize('NFD').replace(/\p{M}/gu, '')).toUpperCase();
  if (/^[A-Z]$/.test(base)) return base;
  return 'other';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true });

export interface ArtistSortable {
  name: string;
  sortName?: string | null;
}

/** A precomputed key so a sort over thousands of artists does the work once. */
export interface ArtistNameKey {
  rank: number;
  /** blank names ("Unknown artist") go last within "#" */
  blank: boolean;
  text: string;
  label: string;
}

export function artistNameKey(artist: ArtistSortable): ArtistNameKey {
  const group = artistGroup(artist.name, artist.sortName);
  const label = cleanArtistName(artist.name);
  return {
    rank: GROUP_RANK.get(group) ?? ARTIST_GROUP_ORDER.length,
    blank: !label,
    text: artistSortText(artist.name, artist.sortName),
    label,
  };
}

/** Name A–Z: Latin letters, digits, other scripts, then symbols and blanks. */
export function compareArtistNameKeys(a: ArtistNameKey, b: ArtistNameKey): number {
  return a.rank - b.rank
    || Number(a.blank) - Number(b.blank)
    || collator.compare(a.text, b.text)
    || collator.compare(a.label, b.label)
    || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

export function compareArtistNames(a: ArtistSortable, b: ArtistSortable): number {
  return compareArtistNameKeys(artistNameKey(a), artistNameKey(b));
}

/**
 * One or two characters for a placeholder tile: the first letters of the
 * first two words ("Massive Attack" → "MA", "이지수" → "이"), "#" for a
 * symbol-only name and "?" for a blank one.
 */
export function artistInitials(name: string | null | undefined): string {
  const clean = cleanArtistName(name);
  if (!clean) return '?';
  const words = clean.replace(LEADING_ARTICLE, '').split(' ')
    .map((word) => [...word].find((ch) => WORD_CHAR.test(ch)))
    .filter((ch): ch is string => !!ch);
  if (!words.length) return '#';
  const first = words[0]!;
  // CJK and Hangul syllables are wide: one reads better than two
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  return (first + (words[1] ?? '')).toUpperCase();
}

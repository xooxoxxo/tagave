/**
 * Move to album (0080): the names a moved file and a new album folder take.
 * tagave has no naming setting, so a file follows the target folder's own
 * names when they share one pattern ("03 - Title.flac", "03. Title.flac",
 * "1-03 - Title.flac", "03 - Artist - Title.flac"), and "NN - Title.ext"
 * otherwise. A new folder is "<Album artist>/<Year> - <Album>" under the
 * root of the files.
 */
import { safeNamePart } from './splitImage.js';

export interface NamingPattern {
  /** "1-03": the disc before the number */
  disc: boolean;
  digits: number;
  /** what follows the number: " - ", ". ", " " */
  sep: string;
  /** "03 - Artist - Title" */
  artist: boolean;
}

export const DEFAULT_NAMING: NamingPattern = { disc: false, digits: 2, sep: ' - ', artist: false };

const NAME = /^(?:(\d{1,2})-)?(\d{1,3})( - |\. | |_| -|-)(.+)$/;

const stem = (name: string) => name.replace(/\.[^./]+$/, '');

/** The pattern of one name, or null when it starts with no track number. */
export function namingOf(name: string, artist?: string | null): NamingPattern | null {
  const m = NAME.exec(stem(name).normalize('NFC'));
  if (!m) return null;
  const rest = m[4]!;
  const a = artist ? safeNamePart(artist, '') : '';
  return {
    disc: !!m[1],
    digits: m[2]!.length,
    sep: m[3]!,
    artist: !!a && rest.toLowerCase().startsWith(`${a.toLowerCase()} - `),
  };
}

/**
 * The folder's pattern: the one every numbered name shares (two at least, or
 * the folder's only one), else null. A folder of mixed names has none.
 */
export function folderNaming(names: readonly string[], artist?: string | null): NamingPattern | null {
  const found = names.map((n) => namingOf(n, artist)).filter((p): p is NamingPattern => p !== null);
  if (found.length === 0) return null;
  const key = (p: NamingPattern) => `${p.disc}|${p.digits}|${p.sep}|${p.artist}`;
  const first = key(found[0]!);
  if (!found.every((p) => key(p) === first)) return null;
  if (found.length < Math.min(2, names.length)) return null;
  return found[0]!;
}

/** "NN - Title.ext" in words, for the preview: "01 - Title", "1-01. Title", "01 - Artist - Title". */
export function describeNaming(p: NamingPattern): string {
  const n = `${p.disc ? '1-' : ''}${'0'.repeat(Math.max(0, p.digits - 1))}1`;
  return `${n}${p.sep}${p.artist ? 'Artist - ' : ''}Title`;
}

export interface NameInput {
  disc: number;
  position: number;
  title: string;
  artist?: string | null;
  /** with its dot: ".flac" */
  ext: string;
}

/** A file's new name under the pattern. The disc shows only on a release of several discs. */
export function movedFileName(p: NamingPattern, t: NameInput, discs: number): string {
  const num = String(t.position).padStart(p.digits, '0');
  const disc = p.disc || discs > 1 ? `${t.disc}-` : '';
  const artist = p.artist && t.artist ? `${safeNamePart(t.artist, 'Unknown artist')} - ` : '';
  return `${disc}${num}${p.sep}${artist}${safeNamePart(t.title)}${t.ext.toLowerCase()}`;
}

/** "<Album artist>/<Year> - <Album>" (no year: "<Album artist>/<Album>"). */
export function newAlbumDir(albumArtist: string, title: string, year: number | null): string {
  const a = safeNamePart(albumArtist, 'Unknown artist');
  const t = safeNamePart(title, 'Untitled');
  return `${a}/${year ? `${year} - ${t}` : t}`;
}

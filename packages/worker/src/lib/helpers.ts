import { createHash } from 'node:crypto';

/**
 * Pure helpers for the scan/cluster pipeline. Everything here is
 * deterministic and side-effect free so it can be unit-tested without a
 * database or a filesystem.
 */

/** Audio extensions the scanner indexes (spec LIB-2). */
export const AUDIO_EXTS = new Set([
  '.flac', '.mp3', '.m4a', '.mp4', '.ogg', '.opus', '.wav', '.aiff', '.aif',
  '.ape', '.wv', '.dsf', '.dff',
]);

/** Sidecar kinds by extension (spec LIB-2). */
const SIDECAR_KINDS: Record<string, string> = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image',
  '.cue': 'cue',
  '.log': 'log',
  '.txt': 'text', '.nfo': 'text',
  '.m3u': 'other', '.m3u8': 'other', '.sfv': 'other', '.pdf': 'other',
};

export function sidecarKind(name: string): string | null {
  const ext = extOf(name);
  return SIDECAR_KINDS[ext] ?? null;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTS.has(extOf(name));
}

/**
 * NFC-normalized, casefolded, trimmed key for grouping. The archive mixes
 * NFC and NFD spellings of the same names (macOS SMB vs NAS bytes), and the
 * volume is case-insensitive — keys must collapse both.
 */
export function normKey(s: string): string {
  return s.normalize('NFC').toLowerCase().trim();
}

/** NFC form for storage. Never use the result to open files — open with the
 * exact dirent name the walk produced. */
export function storagePath(p: string): string {
  return p.normalize('NFC');
}

const DISC_DIR_RE = /^(?:cd|disc|disk|vol(?:ume)?\.?)[\s._-]*(\d{1,3})$/i;

/** If a directory basename denotes a disc ("CD1", "Disc 2", "Vol. 3"),
 * return its number, else null. */
export function discDirNumber(basename: string): number | null {
  const m = DISC_DIR_RE.exec(basename.trim());
  if (!m || !m[1]) return null;
  return parseInt(m[1], 10);
}

/**
 * A disc token appended to an album folder name: "Album CD1",
 * "Album (Disc 2)", "Album - Disc 2", "Album [CD 2]", "Album Vol. 2".
 * The closing bracket is optional on purpose — real folders drop it
 * ("The Life & Times Of Laddio Bolocko (Disc 2").
 */
const FOLDER_DISC_TOKEN_RE =
  /^(.+?)(?:[\s._-]+|\s*[([{]\s*)(cd|disc|disk|vol(?:ume)?)\.?[\s._-]*(\d{1,3})\s*[)\]}]?$/i;

/**
 * Splits a trailing disc token off a folder name. `kind` separates the
 * unambiguous spellings (cd/disc/disk) from "Vol. 2", which is just as often
 * part of a real album title — the caller only honours a 'vol' token when a
 * sibling folder carries a different volume number (spec: disc precedence).
 */
export function discTokenOfFolder(
  basename: string,
): { title: string; disc: number; kind: 'disc' | 'vol' } | null {
  const m = FOLDER_DISC_TOKEN_RE.exec(basename.trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const title = m[1].replace(/[\s._\-([{]+$/, '').trim();
  if (!title) return null;
  const disc = parseInt(m[3], 10);
  if (!(disc > 0)) return null;
  return { title, disc, kind: /^vol/i.test(m[2]) ? 'vol' : 'disc' };
}

/**
 * "n-tt" filename prefix: "2-01 Title" is track 1 of disc 2. The track part
 * must be exactly two digits followed by a non-digit, so "201 Title" (a bare
 * three-digit track number) and "1969 - Title" are not disc prefixes.
 */
const FILE_DISC_PREFIX_RE = /^(\d{1,2})[-._](\d{2})(?!\d)/;

export function filenameDiscPrefix(basename: string): { disc: number; track: number } | null {
  const m = FILE_DISC_PREFIX_RE.exec(basename.trim());
  if (!m || !m[1] || !m[2]) return null;
  const disc = parseInt(m[1], 10);
  const track = parseInt(m[2], 10);
  if (!(disc > 0) || !(track > 0)) return null;
  return { disc, track };
}

const YEAR_RE = /(?:19|20)\d{2}/;

/** First plausible release year found in the string, else null. */
export function extractYear(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = YEAR_RE.exec(String(s));
  return m ? parseInt(m[0], 10) : null;
}

const TRACK_PREFIX_RE = /^\s*(\d{1,3})(?:\s*[-._)\]]+\s*|\s+)/;

/** Leading track number of a filename ("01 - Foo.mp3" → 1), else null. */
export function trackNoFromName(basename: string): number | null {
  const m = TRACK_PREFIX_RE.exec(basename);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 1000 ? n : null;
}

/** Title guess from a filename: strip extension and leading track number
 * (or "n-tt" disc-and-track prefix). */
export function titleFromName(basename: string): string {
  const stem = basename.trim().replace(/\.[^.]+$/, '');
  let stripped: string;
  if (filenameDiscPrefix(stem)) {
    stripped = stem.replace(FILE_DISC_PREFIX_RE, '').replace(/^[\s._\-)\]]+/, '').trim();
  } else {
    stripped = stem.replace(TRACK_PREFIX_RE, '').trim();
  }
  return stripped || stem;
}

/**
 * Deterministic cluster key (spec LIB-6): stable across rescans as long as
 * the same directories hold the same album/artist identity.
 */
export function clusterKey(
  libraryId: string,
  dirPaths: string[],
  albumKey: string,
  artistKey: string,
): string {
  const h = createHash('sha1');
  h.update(libraryId);
  h.update('\n');
  h.update([...dirPaths].map(storagePath).sort().join('|'));
  h.update('\n');
  h.update(albumKey);
  h.update('\n');
  h.update(artistKey);
  return h.digest('hex');
}

/** Stable sha1 digest of a tag snapshot, key-order independent. */
export function tagsDigest(tags: unknown): string {
  return createHash('sha1').update(stableStringify(tags)).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/** POSIX dirname for rel paths ('' for top level). */
export function relDirname(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

export function relBasename(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

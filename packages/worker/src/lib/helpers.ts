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

/** Title guess from a filename: strip extension and leading track number. */
export function titleFromName(basename: string): string {
  const stem = basename.replace(/\.[^.]+$/, '');
  const stripped = stem.replace(TRACK_PREFIX_RE, '').trim();
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

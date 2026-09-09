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

/**
 * Highest disc number an "n-tt" filename prefix is allowed to name. Above it
 * the leading number is something else: prod's only 20+ "disc" prefixes are
 * a flat rip numbered "10-10 - Title.mp3" and a 50-CD Elvis box whose discs
 * are all in the tags anyway.
 */
const MAX_PREFIX_DISC = 20;

/**
 * Do the "n-tt" prefixes inside ONE cluster really name discs?
 *
 * The tier exists for box sets ripped flat into a single folder, and it used
 * to fire on any two distinct leading numbers. That fabricated a disc per
 * track for the widespread "n-nn" naming where the leading number simply
 * repeats the track number (prod: Angels & Airwaves "We Don't Need To
 * Whisper" — "01 - x.mp3", "2-02 - x.mp3", … "10-10 - x.mp3" — became ten
 * one-track discs). A real multi-disc rip looks nothing like that, so a
 * prefix set counts only when all four hold:
 *
 *   - two or more distinct disc numbers (an unprefixed disc 1 still counts:
 *     the set qualifies on discs 2 and 3),
 *   - no disc number above MAX_PREFIX_DISC,
 *   - every disc group has at least two files and starts at track 1 or 2
 *     (one file under a number, or a group starting at track 8, is a track
 *     number wearing a disc's clothes),
 *   - fewer than half the prefixed files have disc === track.
 *
 * False negatives are cheap: the tier is the weakest one, below the disk.no
 * tag, and every genuine set it rejects on prod (a 4-CD compilation numbered
 * continuously 1..48, a 10-CD box of one-track mixes) carries disc numbers in
 * its tags.
 */
export function filenameDiscPrefixesApply(basenames: Iterable<string>): boolean {
  const byDisc = new Map<number, number[]>();
  let prefixed = 0;
  let discEqualsTrack = 0;
  for (const name of basenames) {
    const p = filenameDiscPrefix(name);
    if (!p) continue;
    prefixed += 1;
    if (p.disc === p.track) discEqualsTrack += 1;
    const tracks = byDisc.get(p.disc);
    if (tracks) tracks.push(p.track);
    else byDisc.set(p.disc, [p.track]);
  }
  if (byDisc.size < 2) return false;
  for (const [disc, tracks] of byDisc) {
    if (disc > MAX_PREFIX_DISC) return false;
    if (tracks.length < 2) return false;
    if (Math.min(...tracks) > 2) return false;
  }
  return discEqualsTrack * 2 < prefixed;
}

/**
 * The album tag of a disc folder often carries the token too ("… Disc 1",
 * "… (CD2)"). Once a scope spans discs those tags name one album, so the
 * token comes off before grouping. Only the unambiguous cd/disc/disk
 * spellings are stripped: "Mixtape Vol. 2" and "Mixtape Vol. 3" are two
 * albums, not two discs.
 */
export function stripDiscTokenFromTitle(title: string): string {
  const t = discTokenOfFolder(title);
  return t && t.kind === 'disc' ? t.title : title;
}

/**
 * The scope a cluster.dir job on `dirPath` will actually resolve, as a key:
 * a bare disc subdir ("…/CD1") and every "… CD1"/"… CD2" sibling of one
 * album collapse to the same string. Enqueue and dedupe cluster.dir on this,
 * not on the raw directory, or two sibling jobs race to build one cluster.
 *
 * "Vol. n" siblings are deliberately NOT collapsed (see clusterDirJob): a
 * "Vol. 2" folder is its own album until something else says otherwise.
 */
/**
 * Whether the disc numbers in a group's file tags describe real discs. Some
 * rips write each file's own track number into disk.no ("01", "2-02", "3-03"
 * … with disk.no 1..10), which would fabricate a disc per track. Distrust the
 * tag tier when at least two disc values appear and either half of the tagged
 * files have disc == track, a value is absurd, or most discs hold one file.
 */
export function tagDiscsPlausible(entries: Iterable<{ disc: number | null; track: number | null }>): boolean {
  const perDisc = new Map<number, number>();
  let tagged = 0;
  let discEqualsTrack = 0;
  for (const e of entries) {
    if (e.disc === null || e.disc === undefined) continue;
    tagged += 1;
    if (e.track !== null && e.track !== undefined && e.disc === e.track) discEqualsTrack += 1;
    perDisc.set(e.disc, (perDisc.get(e.disc) ?? 0) + 1);
  }
  if (perDisc.size < 2) return true;
  if ([...perDisc.keys()].some((d) => d < 1 || d > 30)) return false;
  if (discEqualsTrack * 2 >= tagged) return false;
  const singles = [...perDisc.values()].filter((n) => n === 1).length;
  return singles * 2 <= perDisc.size;
}

export function clusterScopeKey(dirPath: string): string {
  if (dirPath === '') return '';
  const base = relBasename(dirPath);
  if (discDirNumber(base) !== null) return relDirname(dirPath);
  const token = discTokenOfFolder(base);
  if (token && token.kind === 'disc') return relDirname(dirPath) + '\n' + normKey(token.title);
  return dirPath;
}

/** pg-boss singleton key for cluster.dir, keyed on the resolved scope. */
export function clusterSingletonKey(scanRootId: string, dirPath: string): string {
  return `cluster:${scanRootId}:${clusterScopeKey(dirPath)}`;
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

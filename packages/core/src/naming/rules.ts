/**
 * Naming rules (vault "tagave - Naming Rules and Drop Pool"): where a file
 * belongs in the music folder, from its tags. One pure module: the tag plan's
 * preview and its move, Library care › Organize, the drop pool's import and
 * Settings › Library › Naming all render paths here.
 *
 * A rule is a folder template and a file template:
 *
 *   folder  {initial}/{albumartist}/[{year} - ]{album}
 *   file    [{disc}-][{track:02} - ]{title}
 *
 * Variables: {initial} {albumartist} {artist} {year} {album} {disc} {track}
 * {title} {ext}; a number takes a width, {track:02}. `[ … ]` is an optional
 * part: it is left out when any variable in it is empty. {disc} is empty on a
 * release of one disc, so `[{disc}-]` numbers discs only on a multi-disc
 * release ("1-01 - Title"). The extension follows the file name unless the
 * template ends with {ext}.
 *
 * Special rules replace the folder template: a soundtrack (MusicBrainz
 * secondary type Soundtrack) goes to `_OST/…`, a compilation to
 * `_Various Artists/…`. A folder named in "Leave alone" (by its first
 * characters: `#`, `_duplicates`) is never touched.
 *
 * Every path part is a safe name: no / \ : * ? " < > |, no control
 * characters, no trailing dots or spaces, NFC, at most 200 UTF-8 bytes; a
 * whole path at most 1024. The case stays as tagged.
 */
import { safeNamePart } from '../audio/splitImage.js';

export const NAMING_VARIABLES = ['initial', 'albumartist', 'artist', 'year', 'album', 'disc', 'track', 'title', 'ext'] as const;
export type NamingVariable = (typeof NAMING_VARIABLES)[number];

export type SpecialWhen = 'soundtrack' | 'compilation';

export interface SpecialRule {
  when: SpecialWhen;
  /** a folder template; empty: the rule is off */
  folder: string;
}

export interface NamingRules {
  folder: string;
  file: string;
  /** first match wins: soundtrack, then compilation */
  special: SpecialRule[];
  /** folder names (their first characters) Organize never touches */
  leaveAlone: string[];
}

export const DEFAULT_FOLDER_TEMPLATE = '{initial}/{albumartist}/[{year} - ]{album}';
export const DEFAULT_FILE_TEMPLATE = '[{disc}-][{track:02} - ]{title}';

export const DEFAULT_SPECIAL_RULES: readonly SpecialRule[] = [
  { when: 'soundtrack', folder: '_OST/[{year} - ]{album}' },
  { when: 'compilation', folder: '_Various Artists/[{year} - ]{album}' },
];

export const DEFAULT_LEAVE_ALONE: readonly string[] = ['#', '_duplicates'];

export const DEFAULT_NAMING_RULES: NamingRules = {
  folder: DEFAULT_FOLDER_TEMPLATE,
  file: DEFAULT_FILE_TEMPLATE,
  special: DEFAULT_SPECIAL_RULES.map((r) => ({ ...r })),
  leaveAlone: [...DEFAULT_LEAVE_ALONE],
};

/** The bytes one path part and one whole path may take. */
export const SEGMENT_MAX_BYTES = 200;
export const PATH_MAX_BYTES = 1024;

/** What one file's path is made of: its tags, after any tag changes. */
export interface NamingValues {
  albumartist: string | null;
  artist: string | null;
  album: string | null;
  title: string | null;
  /** 'YYYY', 'YYYY-MM-DD' or a number: the year is its first four digits */
  year: string | number | null;
  disc: number | null;
  /** discs on the release; {disc} shows only when more than one */
  discs: number;
  track: number | null;
  /** without the dot: 'flac' */
  ext: string;
  compilation: boolean;
  soundtrack: boolean;
}

// ---------------------------------------------------------------- templates

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: NamingVariable; width: number }
  | { kind: 'optional'; tokens: Token[] };

const VAR = /^\{([a-z]+)(?::(0?\d))?\}/;

/** Parses one template part (no '/'). Throws with a reason on a bad template. */
function parsePart(part: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let text = '';
  const flush = () => { if (text) out.push({ kind: 'text', text }); text = ''; };
  while (i < part.length) {
    const ch = part[i]!;
    if (ch === '{') {
      const m = VAR.exec(part.slice(i));
      if (!m) throw new Error(`Unclosed { at ${i + 1}`);
      const name = m[1] as NamingVariable;
      if (!(NAMING_VARIABLES as readonly string[]).includes(name)) throw new Error(`Unknown variable {${m[1]}}`);
      flush();
      out.push({ kind: 'var', name, width: m[2] ? Number(m[2]) : 0 });
      i += m[0].length;
    } else if (ch === '[') {
      const end = part.indexOf(']', i);
      if (end < 0) throw new Error(`Unclosed [ at ${i + 1}`);
      const inner = part.slice(i + 1, end);
      if (inner.includes('[')) throw new Error('Optional parts cannot nest');
      flush();
      const tokens = parsePart(inner);
      if (!tokens.some((t) => t.kind === 'var')) throw new Error('An optional part needs a variable');
      out.push({ kind: 'optional', tokens });
      i = end + 1;
    } else if (ch === ']' || ch === '}') {
      throw new Error(`Stray ${ch} at ${i + 1}`);
    } else {
      text += ch;
      i++;
    }
  }
  flush();
  return out;
}

function parseTemplate(template: string): Token[][] {
  const t = template.trim().replace(/^\/+|\/+$/g, '');
  if (!t) throw new Error('Empty template');
  return t.split('/').map((p, n) => {
    if (!p.trim()) throw new Error(`Empty folder at part ${n + 1}`);
    return parsePart(p);
  });
}

/** Why a template is not usable, or null. A file template is one part (no '/'). */
export function templateProblem(template: string, kind: 'folder' | 'file'): string | null {
  try {
    const parts = parseTemplate(template);
    if (kind === 'file' && parts.length > 1) return 'A file name cannot hold /';
    const vars = parts.flat().flatMap((t) => (t.kind === 'optional' ? t.tokens : [t])).filter((t) => t.kind === 'var').map((t) => (t as { name: string }).name);
    if (kind === 'file' && !vars.includes('title') && !vars.includes('track')) return 'Needs {title} or {track}';
    if (kind === 'folder' && !vars.includes('album')) return 'Needs {album}';
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Every problem of a rule set, by field; empty when it is usable. */
export function rulesProblems(rules: NamingRules): Record<string, string> {
  const out: Record<string, string> = {};
  const f = templateProblem(rules.folder, 'folder');
  if (f) out['folder'] = f;
  const n = templateProblem(rules.file, 'file');
  if (n) out['file'] = n;
  rules.special.forEach((s, i) => {
    if (!s.folder.trim()) return;
    const p = templateProblem(s.folder, 'folder');
    if (p) out[`special.${i}`] = p;
  });
  return out;
}

// ---------------------------------------------------------------- values

const ARTICLE = /^(?:the|an|a)\s+(?=\S)/i;

/** Latin letters some first letters fold to that NFD does not reach. */
const LATIN_FOLD: Record<string, string> = {
  'ß': 'S', 'Æ': 'A', 'æ': 'A', 'Ø': 'O', 'ø': 'O', 'Œ': 'O', 'œ': 'O', 'Ł': 'L', 'ł': 'L', 'Đ': 'D', 'đ': 'D',
  'Ð': 'D', 'ð': 'D', 'Þ': 'T', 'þ': 'T', 'ı': 'I', 'Ħ': 'H', 'ħ': 'H', 'Ŧ': 'T', 'ŧ': 'T',
};

/** Greek and Cyrillic first letters as the Latin letter they are spelt with. */
const SCRIPT_FOLD: Record<string, string> = {
  // Greek
  'Α': 'A', 'Β': 'V', 'Γ': 'G', 'Δ': 'D', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'I', 'Θ': 'T', 'Ι': 'I', 'Κ': 'K', 'Λ': 'L', 'Μ': 'M',
  'Ν': 'N', 'Ξ': 'X', 'Ο': 'O', 'Π': 'P', 'Ρ': 'R', 'Σ': 'S', 'Τ': 'T', 'Υ': 'Y', 'Φ': 'F', 'Χ': 'C', 'Ψ': 'P', 'Ω': 'O',
  // Cyrillic
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Ґ': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'E', 'Є': 'E', 'Ж': 'Z', 'З': 'Z', 'И': 'I',
  'І': 'I', 'Ї': 'I', 'Й': 'I', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T',
  'У': 'U', 'Ў': 'U', 'Ф': 'F', 'Х': 'K', 'Ц': 'T', 'Ч': 'C', 'Ш': 'S', 'Щ': 'S', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E',
  'Ю': 'I', 'Я': 'I', 'Ђ': 'D', 'Ј': 'J', 'Љ': 'L', 'Њ': 'N', 'Ћ': 'C', 'Џ': 'D',
};

export const INITIAL_NUMERIC = '_Numeric';
export const INITIAL_OTHER = '_Other';

/**
 * The letter folder of an album artist: the first letter after a leading
 * "The ", "A " or "An " (and any leading punctuation), folded to Latin
 * ("Ö" → O, "Б" → B); a digit → _Numeric; anything else → _Other.
 */
export function initialOf(albumArtist: string | null | undefined): string {
  let s = (albumArtist ?? '').normalize('NFC').trim();
  s = s.replace(/^[^\p{L}\p{N}]+/u, '');
  s = s.replace(ARTICLE, '');
  s = s.replace(/^[^\p{L}\p{N}]+/u, '');
  for (const ch of s) {
    if (/\p{N}/u.test(ch)) return /[0-9]/.test(ch) ? INITIAL_NUMERIC : INITIAL_OTHER;
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    const latin = LATIN_FOLD[ch] ?? (/^[a-z]$/i.test(base) ? base : undefined) ?? SCRIPT_FOLD[ch.toUpperCase()];
    if (latin === '') continue; // a sign letter (Ъ, Ь) carries no sound: the next one counts
    return latin ? latin.toUpperCase() : INITIAL_OTHER;
  }
  return INITIAL_OTHER;
}

const yearOf = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  const m = /(\d{4})/.exec(String(v));
  return m && Number(m[1]) > 0 ? m[1]! : '';
};

const clean = (s: string | null | undefined) => (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

function valueOf(name: NamingVariable, v: NamingValues): string | number | null {
  switch (name) {
    case 'initial': return initialOf(clean(v.albumartist) || clean(v.artist));
    case 'albumartist': return clean(v.albumartist) || clean(v.artist) || null;
    case 'artist': return clean(v.artist) || clean(v.albumartist) || null;
    case 'album': return clean(v.album) || null;
    case 'title': return clean(v.title) || null;
    case 'year': return yearOf(v.year) || null;
    case 'disc': return v.discs > 1 && v.disc && v.disc > 0 ? v.disc : null;
    case 'track': return v.track && v.track > 0 ? v.track : null;
    case 'ext': return clean(v.ext).replace(/^\./, '').toLowerCase() || null;
  }
}

/** What an empty required variable becomes, so a part is never blank. */
const FALLBACK: Partial<Record<NamingVariable, string>> = {
  albumartist: 'Unknown artist', artist: 'Unknown artist', album: 'Untitled', title: 'Untitled',
};

function renderVar(t: Extract<Token, { kind: 'var' }>, v: NamingValues): string {
  const raw = valueOf(t.name, v);
  if (raw === null) return '';
  const s = String(raw);
  return t.width && /^\d+$/.test(s) ? s.padStart(t.width, '0') : s;
}

function renderTokens(tokens: Token[], v: NamingValues, fallback: boolean): string {
  let out = '';
  for (const t of tokens) {
    if (t.kind === 'text') out += t.text;
    else if (t.kind === 'var') out += renderVar(t, v) || (fallback ? FALLBACK[t.name] ?? '' : '');
    else if (t.tokens.every((x) => x.kind !== 'var' || renderVar(x, v) !== '')) out += renderTokens(t.tokens, v, false);
  }
  return out;
}

// ---------------------------------------------------------------- safe names

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Cut to at most `max` UTF-8 bytes on a character boundary, trailing dots and spaces off. */
function capBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const chars = Array.from(s);
  while (chars.length && byteLength(chars.join('')) > max) chars.pop();
  return chars.join('').replace(/[. ]+$/, '');
}

/** One path part as a safe name (rr72's safeNamePart, at 200 bytes). */
export function safeSegment(s: string, fallback = 'Untitled'): string {
  return safeNamePart(s, fallback, SEGMENT_MAX_BYTES);
}

/** Parts within PATH_MAX_BYTES as a whole: the longest part is cut first. The extension is kept. */
export function capPath(parts: string[], ext = ''): string[] {
  const out = [...parts];
  const total = () => byteLength(out.join('/')) + byteLength(ext);
  while (total() > PATH_MAX_BYTES) {
    let longest = 0;
    out.forEach((p, i) => { if (byteLength(p) > byteLength(out[longest]!)) longest = i; });
    const over = total() - PATH_MAX_BYTES;
    const cut = capBytes(out[longest]!, Math.max(1, byteLength(out[longest]!) - over));
    if (cut === out[longest]) break;
    out[longest] = cut || '_';
  }
  return out;
}

// ---------------------------------------------------------------- paths

export type RuleName = 'default' | SpecialWhen;

export interface RulePath {
  /** the album folder, relative to the music folder */
  dir: string;
  /** the file name, with its extension */
  name: string;
  /** dir/name */
  path: string;
  rule: RuleName;
}

/** The folder template a file follows, and which rule chose it. */
export function folderRuleFor(rules: NamingRules, v: NamingValues): { template: string; rule: RuleName } {
  for (const s of rules.special) {
    if (!s.folder.trim()) continue;
    if (s.when === 'soundtrack' && v.soundtrack) return { template: s.folder, rule: 'soundtrack' };
    if (s.when === 'compilation' && v.compilation) return { template: s.folder, rule: 'compilation' };
  }
  return { template: rules.folder, rule: 'default' };
}

/** The album folder alone. */
export function ruleDir(rules: NamingRules, v: NamingValues): { dir: string; rule: RuleName } {
  const { template, rule } = folderRuleFor(rules, v);
  const parts = parseTemplate(template).map((p) => safeSegment(renderTokens(p, v, true)));
  return { dir: capPath(parts).join('/').normalize('NFC'), rule };
}

/** The file name alone (with its extension). */
export function ruleFileName(rules: NamingRules, v: NamingValues): string {
  const [tokens] = parseTemplate(rules.file);
  const endsWithExt = /\{ext\}\s*$/.test(rules.file);
  const ext = valueOf('ext', v);
  const stem = renderTokens(tokens!, v, true);
  if (endsWithExt) return safeSegment(stem, 'Untitled');
  const suffix = ext ? `.${ext}` : '';
  return `${capBytes(safeSegment(stem, 'Untitled'), SEGMENT_MAX_BYTES - byteLength(suffix))}${suffix}`.normalize('NFC');
}

/** Where a file belongs under the rules. */
export function rulePath(rules: NamingRules, v: NamingValues, dirOverride?: string): RulePath {
  const { dir: ruled, rule } = ruleDir(rules, v);
  const dir = dirOverride ?? ruled;
  const name = ruleFileName(rules, v);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const parts = capPath([...dir.split('/').filter(Boolean), name.slice(0, name.length - ext.length)], ext);
  const fileName = `${parts.pop()!}${ext}`;
  const finalDir = parts.join('/');
  return { dir: finalDir, name: fileName, path: finalDir ? `${finalDir}/${fileName}` : fileName, rule };
}

/** A folder the rules leave alone: any folder of the path starts with an entry ("#", "_duplicates"). */
export function isLeftAlone(relPath: string, leaveAlone: readonly string[]): boolean {
  const entries = leaveAlone.map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return false;
  const dirs = relPath.normalize('NFC').split('/').slice(0, -1);
  return dirs.some((d) => entries.some((e) => d.startsWith(e.normalize('NFC'))));
}

/** Same path, NFC and case folded (the owner's share is case-insensitive). */
export const samePath = (a: string, b: string) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

// ---------------------------------------------------------------- values from tags

type FieldValue = string | string[] | null | undefined;

const first = (v: FieldValue): string | null => (Array.isArray(v) ? (v[0] ?? null) : v ?? null);
const int = (v: FieldValue): number | null => {
  const n = Number.parseInt(String(first(v) ?? '').split('/')[0] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const VARIOUS = /^(?:various(?: artists)?|va|v\.a\.|verschiedene(?: interpreten)?|artistes divers)$/i;

/**
 * Naming values from canonical tag fields (the tag engine's names:
 * albumartist, tracknumber, originaldate …) and the file's extension.
 * `discs` is how many discs the album has (its files' disc numbers, or
 * totaldiscs). `soundtrack`: the release group's secondary types say so, or
 * the releasetype tag does.
 */
export function namingValuesOf(
  fields: Partial<Record<string, FieldValue>>,
  ext: string,
  opts: { discs?: number; soundtrack?: boolean } = {},
): NamingValues {
  const albumartist = first(fields['albumartist']);
  const releasetype = String(first(fields['releasetype']) ?? '').toLowerCase();
  const total = int(fields['totaldiscs']);
  return {
    albumartist,
    artist: first(fields['artist']),
    album: first(fields['album']),
    title: first(fields['title']),
    year: first(fields['originaldate']) ?? first(fields['date']),
    disc: int(fields['discnumber']),
    discs: Math.max(opts.discs ?? 0, total ?? 0, 1),
    track: int(fields['tracknumber']),
    ext: ext.replace(/^\./, ''),
    compilation: first(fields['compilation']) === '1' || (!!albumartist && VARIOUS.test(albumartist.trim())),
    soundtrack: opts.soundtrack === true || /\bsoundtrack\b/.test(releasetype),
  };
}

// ---------------------------------------------------------------- detection

export interface NamingSample {
  /** the file's path relative to its music folder */
  path: string;
  values: NamingValues;
}

export interface Detected {
  rules: NamingRules;
  /** a library pattern was recognised (else the default) */
  detected: boolean;
  /** samples whose folder (and file name) the chosen rules reproduce */
  matched: number;
  sampled: number;
}

const FOLDER_CANDIDATES = [
  DEFAULT_FOLDER_TEMPLATE,
  '{albumartist}/[{year} - ]{album}',
  '{albumartist}/{album}[ ({year})]',
  '{albumartist}/{album}',
  '{albumartist} - {album}',
  '{initial}/{albumartist}/{album}',
];

const FILE_CANDIDATES = [
  DEFAULT_FILE_TEMPLATE,
  '[{disc}-][{track:02}. ]{title}',
  '[{disc}-][{track:02} ]{title}',
  '[{disc}-][{track:02} - ]{artist} - {title}',
];

/** The share of samples a pattern must reproduce to be taken for the library's own. */
export const DETECT_MIN_SHARE = 0.5;

/**
 * The library's own pattern, from sample paths and their tags: each candidate
 * template renders every sample, and the one that reproduces the most
 * folders wins when it reproduces at least half; then the file names likewise.
 * Compilations and soundtracks (their own rules) and left-alone folders are
 * not samples. Fewer than three samples: the default.
 */
export function detectNaming(samples: readonly NamingSample[]): Detected {
  const base: NamingRules = { ...DEFAULT_NAMING_RULES, special: DEFAULT_NAMING_RULES.special.map((s) => ({ ...s })), leaveAlone: [...DEFAULT_LEAVE_ALONE] };
  const usable = samples.filter((s) => !s.values.compilation && !s.values.soundtrack && !isLeftAlone(s.path, DEFAULT_LEAVE_ALONE) && s.path.includes('/'));
  if (usable.length < 3) return { rules: base, detected: false, matched: 0, sampled: usable.length };
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const score = (fn: (s: NamingSample) => boolean) => usable.filter(fn).length;
  const folderHits = FOLDER_CANDIDATES.map((t) => ({
    t, n: score((s) => samePath(ruleDir({ ...base, folder: t }, s.values).dir, dirOf(s.path))),
  })).sort((a, b) => b.n - a.n);
  const fileHits = FILE_CANDIDATES.map((t) => ({
    t, n: score((s) => samePath(ruleFileName({ ...base, file: t }, s.values), nameOf(s.path))),
  })).sort((a, b) => b.n - a.n);
  const folder = folderHits[0]!;
  const file = fileHits[0]!;
  const need = Math.ceil(usable.length * DETECT_MIN_SHARE);
  const folderOk = folder.n >= need;
  const fileOk = file.n >= need;
  const rules: NamingRules = { ...base, folder: folderOk ? folder.t : base.folder, file: fileOk ? file.t : base.file };
  const matched = score((s) => samePath(rulePath(rules, s.values).path, s.path));
  return { rules, detected: folderOk && fileOk, matched, sampled: usable.length };
}

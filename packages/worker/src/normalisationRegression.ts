/**
 * Read-only report: which albums the text normaliser change decides
 * differently.
 *
 * The old normaliser kept only ASCII word characters, so every non-ASCII
 * letter was deleted: "Stück" became "stck", and a Japanese, Chinese or
 * Cyrillic title became an empty string that compared equal to any other.
 * The current one keeps letters, digits and combining marks in every script
 * and folds compatibility forms (NFKC).
 *
 * For every album with stored candidates, each candidate release is rebuilt
 * from the stored rows and scored twice against the album's files:
 *
 * - before: the scorer with the old normaliser, copied below as it was;
 * - after: the current scorer.
 *
 * Both sides use the same rebuilt release, so the only difference is the
 * text comparison. Identify's own decision and the library's auto-accept
 * rules are replayed on both. Each album is put in a script bucket by its
 * title and artist. Nothing is written.
 *
 *   DATABASE_URL=postgres://… node packages/worker/dist/normalisationRegression.js \
 *     [--library <id>] [--limit N] [--out <report.md>] [--json <report.json>]
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { localAlbums, localTracks, fetchAutoAcceptRulesRow, artistText } from '@tagave/db';
import { scoreRelease, evaluateAutoAccept, rulesFromStored, mediumCountOf } from '@tagave/core';
import type { WorkerContext } from './lib/context.js';
import { embeddedSourceFileIds, localViewFrom, toScorable } from './jobs/identifyAlbum.js';
import { storedReleases, type StoredRelease } from './lib/storedRelease.js';
import { identifyDecision } from './lib/identifyDecision.js';
import { parseCliArgs, regressionContext, type Outcome } from './barcodeRegression.js';

// ---------------------------------------------------------------------------
// The normaliser before the change, kept as it was (only the names carry a
// "legacy" prefix). NFC + lowercase + strip everything outside [\w\s], where
// \w is ASCII only.
// ---------------------------------------------------------------------------

function legacyNormalizeString(s: string): string {
  if (!s) return '';

  // Unicode NFC normalization (canonical composed form)
  let normalized = s.normalize('NFC');

  // Lowercase
  normalized = normalized.toLowerCase();

  // Remove punctuation and extra whitespace
  // Keep only alphanumeric, spaces, and a few allowed characters
  normalized = normalized.replace(/[^\w\s]/gu, '').trim();

  // Collapse multiple spaces into one
  normalized = normalized.replace(/\s+/g, ' ');

  // Remove leading articles ("the", "a", "an")
  normalized = normalized.replace(/^(the|a|an)\s+/i, '').trim();

  return normalized;
}

/** The old title normaliser (the same as the string one). */
export function legacyNormalizeTitle(s: string): string {
  return legacyNormalizeString(s);
}

function legacyJaroWinklerDistance(a: string, b: string): number {
  const s1 = a.normalize('NFC').toLowerCase();
  const s2 = b.normalize('NFC').toLowerCase();

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

function legacyTokenSetRatio(a: string, b: string): number {
  const normalize = (s: string) => s.normalize('NFC').toLowerCase();
  const s1 = normalize(a);
  const s2 = normalize(b);

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

function legacyStringDistance(a: string, b: string): number {
  const normalized1 = legacyNormalizeString(a);
  const normalized2 = legacyNormalizeString(b);

  if (normalized1 === normalized2) return 0;
  if (!normalized1 || !normalized2) return 1;

  // Jaro-Winkler returns similarity (1 = match), convert to distance
  const jw = 1 - legacyJaroWinklerDistance(normalized1, normalized2);

  // Token-set ratio also returns similarity, convert to distance
  const tokenSet = 1 - legacyTokenSetRatio(normalized1, normalized2);

  // Weighted average: slightly favor Jaro-Winkler for single-word differences
  return jw * 0.6 + tokenSet * 0.4;
}

type ScoringText = NonNullable<Parameters<typeof scoreRelease>[3]>;
/** What the scorer compared text with before the change. */
export const LEGACY_TEXT: ScoringText = { normalizeString: legacyNormalizeString, stringDistance: legacyStringDistance };

// ---------------------------------------------------------------------------
// Script buckets
// ---------------------------------------------------------------------------

export type ScriptBucket = 'latin-ascii' | 'latin-accented' | 'cjk' | 'cyrillic' | 'other' | 'mixed';
export const SCRIPT_BUCKETS: readonly ScriptBucket[] = ['latin-ascii', 'latin-accented', 'cjk', 'cyrillic', 'other', 'mixed'];

const LETTER = /\p{L}/u;
// Script_Extensions, so the kana long-vowel mark and iteration marks count as kana
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
const CYRILLIC = /\p{scx=Cyrillic}/u;
const LATIN = /\p{scx=Latin}/u;
const ASCII_LETTER = /[A-Za-z]/;
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Which script a text is written in, by its letters: one Latin text (plain
 * ASCII or with any non-ASCII Latin letter, accented or full-width), CJK
 * (Han, kana, Hangul), Cyrillic, any other script, or several of these.
 * A text with no letters is latin-ascii when it is ASCII, otherwise other.
 */
export function scriptBucket(text: string | null | undefined): ScriptBucket {
  const s = (text ?? '').normalize('NFC');
  const families = new Set<'latin' | 'cjk' | 'cyrillic' | 'other'>();
  let accented = false;
  for (const ch of s) {
    if (!LETTER.test(ch)) continue;
    if (CJK.test(ch)) families.add('cjk');
    else if (CYRILLIC.test(ch)) families.add('cyrillic');
    else if (LATIN.test(ch)) { families.add('latin'); if (!ASCII_LETTER.test(ch)) accented = true; }
    else families.add('other');
  }
  if (families.size > 1) return 'mixed';
  const only = [...families][0];
  if (only === undefined) return NON_ASCII.test(s) ? 'other' : 'latin-ascii';
  if (only === 'latin') return accented ? 'latin-accented' : 'latin-ascii';
  return only;
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

export interface TopPick { releaseId: string; title: string; distance: number }

export interface NormalisationRow {
  albumId: string;
  state: string;
  title: string | null;
  artist: string | null;
  bucket: { album: ScriptBucket; title: ScriptBucket; artist: ScriptBucket };
  top: { before: TopPick; after: TopPick };
  /** the best two candidates scored exactly the same before, so the old pick was by stored order */
  tiedBefore: boolean;
  identify: { before: string; after: string };
  rules: { before: string; after: string };
  outcome: { before: Outcome; after: Outcome };
  /** matched automatically today */
  live: boolean;
}

export interface BucketCounts {
  albums: number;
  /** albums with a top-candidate, decision or rules change */
  changed: number;
  topChanges: number;
  identifyChanges: number;
  outcomeChanges: number;
}

export interface NotReplayable { albumId: string; title: string | null; artist: string | null; releaseIds: string[] }

export interface NormalisationReport {
  albumsConsidered: number;
  albumsCompared: number;
  topChanges: number;
  identifyChanges: Record<string, number>;
  rulesChanges: Record<string, number>;
  outcomeChanges: Record<string, number>;
  /** per script bucket of the album's title and artist together */
  byBucket: Record<ScriptBucket, BucketCounts>;
  /** the same counts by the title alone and by the artist alone */
  byTitleBucket: Record<ScriptBucket, BucketCounts>;
  byArtistBucket: Record<ScriptBucket, BucketCounts>;
  /** changed albums only */
  rows: NormalisationRow[];
  liveMatchAffected: string[];
  skipped: { noTracks: number };
  notReplayable: NotReplayable[];
  rulesEnabledLibraries: number;
}

const BATCH = 200;

type AlbumRow = typeof localAlbums.$inferSelect;
type TrackRow = typeof localTracks.$inferSelect;
type CandRow = { local_album_id: string; release_id: string; track_count: number | null; date: string | null; artist_credit: unknown };
type Scored = { dbId: string; distance: number; breakdown: Record<string, unknown> };

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const byDistance = (a: Scored, b: Scored) => a.distance - b.distance;
const emptyBuckets = (): Record<ScriptBucket, BucketCounts> => Object.fromEntries(SCRIPT_BUCKETS.map((b) =>
  [b, { albums: 0, changed: 0, topChanges: 0, identifyChanges: 0, outcomeChanges: 0 }])) as Record<ScriptBucket, BucketCounts>;

export async function normalisationRegression(ctx: WorkerContext, opts: { libraryId?: string; limit?: number; batchSize?: number } = {}): Promise<NormalisationReport> {
  const report: NormalisationReport = {
    albumsConsidered: 0, albumsCompared: 0, topChanges: 0, identifyChanges: {}, rulesChanges: {}, outcomeChanges: {},
    byBucket: emptyBuckets(), byTitleBucket: emptyBuckets(), byArtistBucket: emptyBuckets(),
    rows: [], liveMatchAffected: [], skipped: { noTracks: 0 }, notReplayable: [], rulesEnabledLibraries: 0,
  };
  const rulesByLibrary = new Map<string, ReturnType<typeof rulesFromStored>>();
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let after: string | undefined;

  while (report.albumsConsidered < limit) {
    const albums: AlbumRow[] = await ctx.db.select().from(localAlbums).where(and(
      after ? gt(localAlbums.id, after) : undefined,
      opts.libraryId ? eq(localAlbums.libraryId, opts.libraryId) : undefined,
      ne(localAlbums.state, 'ignored'),
      sql`exists (select 1 from match_candidates mc where mc.local_album_id = ${localAlbums.id}
                   and mc.source not like 'mc:%' and mc.excluded is not true)`,
    )).orderBy(asc(localAlbums.id)).limit(Math.min(opts.batchSize ?? BATCH, limit - report.albumsConsidered));
    if (albums.length === 0) break;
    after = albums[albums.length - 1]!.id;
    report.albumsConsidered += albums.length;
    await replayBatch(ctx, albums, report, rulesByLibrary);
  }
  for (const r of rulesByLibrary.values()) if (r.enabled) report.rulesEnabledLibraries += 1;
  return report;
}

async function replayBatch(
  ctx: WorkerContext, albums: AlbumRow[], report: NormalisationReport, rulesByLibrary: Map<string, ReturnType<typeof rulesFromStored>>,
): Promise<void> {
  const ids = albums.map((a) => a.id);
  const trackRows: TrackRow[] = await ctx.db.select().from(localTracks)
    .where(sql`${localTracks.localAlbumId} = any(string_to_array(${ids.join(',')}, ',')::uuid[])`);
  const tracksBy = groupBy(trackRows, (t) => t.localAlbumId ?? '');
  const fileIds = [...new Set(albums.flatMap((a) => embeddedSourceFileIds(tracksBy.get(a.id) ?? [])))];
  const fileRows = fileIds.length === 0 ? [] : await ctx.sql<Array<{ id: string; tags_raw: unknown }>>`
    select id, tags_raw from files where id = any(${fileIds}::uuid[])`;
  const tagsBy = new Map(fileRows.map((f) => [f.id, f.tags_raw]));
  const candRows = await ctx.sql<CandRow[]>`
    select mc.local_album_id, mc.release_id, r.track_count, r.date::text as date, rg.artist_credit
      from match_candidates mc
      join releases r on r.id = mc.release_id
      join release_groups rg on rg.id = r.release_group_id
     where mc.local_album_id = any(${ids}::uuid[]) and mc.source not like 'mc:%' and mc.excluded is not true
     order by mc.local_album_id, mc.distance, mc.release_id`;
  const candsBy = groupBy(candRows, (c) => c.local_album_id);
  const liveRows = await ctx.sql<Array<{ local_album_id: string }>>`
    select distinct local_album_id from album_matches
     where local_album_id = any(${ids}::uuid[]) and status in ('auto', 'confirmed') and decided_by = 'system'`;
  const live = new Set(liveRows.map((r) => r.local_album_id));
  const stored = await storedReleases(ctx, [...new Set(candRows.map((c) => c.release_id))]);

  for (const album of albums) {
    const tracks = tracksBy.get(album.id) ?? [];
    if (tracks.length === 0) { report.skipped.noTracks += 1; continue; }
    const cands = candsBy.get(album.id) ?? [];
    const missing = cands.filter((c) => !stored.get(c.release_id)?.complete).map((c) => c.release_id);
    if (missing.length > 0 || cands.length === 0) {
      report.notReplayable.push({ albumId: album.id, title: album.titleGuess, artist: album.artistGuess, releaseIds: missing });
      continue;
    }
    report.albumsCompared += 1;
    const own = embeddedSourceFileIds(tracks).filter((id) => tagsBy.has(id)).map((id) => ({ tagsRaw: tagsBy.get(id) }));
    const { local } = localViewFrom(album, tracks, own);
    const releases = cands.map((c) => stored.get(c.release_id)!);

    const before: Scored[] = []; const afterList: Scored[] = [];
    for (const s of releases) {
      const scorable = toScorable(s.release);
      const b = scoreRelease(local, scorable, {}, LEGACY_TEXT);
      before.push({ dbId: s.dbId, distance: b.distance, breakdown: b.breakdown as Record<string, unknown> });
      const a = scoreRelease(local, scorable);
      afterList.push({ dbId: s.dbId, distance: a.distance, breakdown: a.breakdown as Record<string, unknown> });
    }
    before.sort(byDistance); afterList.sort(byDistance);

    const relOf = new Map<string, StoredRelease>(releases.map((s) => [s.dbId, s]));
    const candOf = new Map(cands.map((c) => [c.release_id, c]));
    const discNos = tracks.map((t) => t.discNo).filter((d): d is number => d != null);
    const dl = { trackCount: local.tracks.length, discsKnown: discNos.length > 0, localDiscs: new Set(discNos).size };
    const decide = (list: Scored[]) => identifyDecision(list.map((s) => {
      const r = relOf.get(s.dbId)!.release;
      return { id: s.dbId, distance: s.distance, breakdown: s.breakdown, trackCount: r.tracks.length, mediumCount: mediumCountOf(r) ?? 0 };
    }), dl).kind;

    if (!rulesByLibrary.has(album.libraryId)) {
      rulesByLibrary.set(album.libraryId, rulesFromStored(await fetchAutoAcceptRulesRow(ctx.db, album.libraryId)));
    }
    const rules = rulesByLibrary.get(album.libraryId)!;
    const comparable = { title: album.titleGuess, artist: album.artistGuess, year: album.yearGuess, trackCount: tracks.length };
    const byRules = (list: Scored[]) => evaluateAutoAccept(rules, comparable, list.map((s) => {
      const st = relOf.get(s.dbId)!; const r = st.release; const c = candOf.get(s.dbId)!;
      return {
        id: s.dbId, distance: s.distance, breakdown: s.breakdown, provider: r.source, status: st.status,
        title: r.title, artist: artistText(c.artist_credit), date: c.date,
        country: r.country ?? null, trackCount: c.track_count == null ? null : Number(c.track_count),
      };
    })).accept ? 'accept' : 'no';
    const outcomeOf = (kind: string, rule: string): Outcome =>
      kind === 'strong' || kind === 'chip_rule' || kind === 'first_candidate' ? 'auto'
        : kind === 'held' ? (rules.enabled && rule === 'accept' ? 'rules' : 'review')
          : 'unidentified';
    const pick = (s: Scored): TopPick => ({ releaseId: s.dbId, title: relOf.get(s.dbId)!.release.title, distance: Number(s.distance.toFixed(4)) });

    const bucket = { album: scriptBucket(`${album.titleGuess ?? ''} ${album.artistGuess ?? ''}`), title: scriptBucket(album.titleGuess), artist: scriptBucket(album.artistGuess) };
    const tallies = [report.byBucket[bucket.album], report.byTitleBucket[bucket.title], report.byArtistBucket[bucket.artist]];
    for (const t of tallies) t.albums += 1;

    const topB = before[0]!; const topA = afterList[0]!;
    const topChanged = topB.dbId !== topA.dbId;
    const idB = decide(before); const idA = decide(afterList);
    const ruB = byRules(before); const ruA = byRules(afterList);
    if (!topChanged && idB === idA && ruB === ruA) continue;

    const row: NormalisationRow = {
      albumId: album.id, state: album.state, title: album.titleGuess, artist: album.artistGuess, bucket,
      top: { before: pick(topB), after: pick(topA) },
      tiedBefore: before.length > 1 && before[1]!.distance === topB.distance,
      identify: { before: idB, after: idA }, rules: { before: ruB, after: ruA },
      outcome: { before: outcomeOf(idB, ruB), after: outcomeOf(idA, ruA) },
      live: live.has(album.id),
    };
    const outcomeChanged = row.outcome.before !== row.outcome.after;
    if (topChanged) report.topChanges += 1;
    if (idB !== idA) bump(report.identifyChanges, `${idB}→${idA}`);
    if (ruB !== ruA) bump(report.rulesChanges, `${ruB}→${ruA}`);
    if (outcomeChanged) bump(report.outcomeChanges, `${row.outcome.before}→${row.outcome.after}`);
    for (const t of tallies) {
      t.changed += 1;
      if (topChanged) t.topChanges += 1;
      if (idB !== idA) t.identifyChanges += 1;
      if (outcomeChanged) t.outcomeChanges += 1;
    }
    report.rows.push(row);
    if (row.live) report.liveMatchAffected.push(album.id);
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r); const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const cell = (v: string | null | undefined) => (v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const countTable = (m: Record<string, number>) => {
  const keys = Object.keys(m).sort();
  if (keys.length === 0) return '_none_\n';
  return ['| change | albums |', '|---|---:|', ...keys.map((k) => `| ${k} | ${m[k]} |`)].join('\n') + '\n';
};
const bucketTable = (m: Record<ScriptBucket, BucketCounts>) => [
  '| script | albums | changed | top candidate | identify decision | outcome |', '|---|---:|---:|---:|---:|---:|',
  ...SCRIPT_BUCKETS.map((b) => { const c = m[b]; return `| ${b} | ${c.albums} | ${c.changed} | ${c.topChanges} | ${c.identifyChanges} | ${c.outcomeChanges} |`; }),
].join('\n') + '\n';

/** The report as Markdown: album ids, titles and artists only, no file names or folders. */
export function renderNormalisationReport(r: NormalisationReport, generatedAt = new Date()): string {
  const out: string[] = [];
  out.push('# Text normaliser change: regression report', '');
  out.push(`Generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Read-only replay; nothing was written.`, '');
  out.push('## How to read this', '');
  out.push(
    '- **before**: the scorer with the old normaliser (NFC, lowercase, then every character outside ASCII letters, digits, underscore and spaces deleted). "Stück" read as "stck"; a Japanese, Chinese or Cyrillic title read as an empty string, which compared equal to any other empty string.',
    '- **after**: the current scorer (NFKC, lowercase; letters, digits and combining marks kept in every script; full-width forms folded; accents not folded).',
    '- Both sides score the same candidate releases, rebuilt from what was stored when the album was identified. Albums are not filtered: every album with stored candidates is replayed.',
    '- **top candidate** changes when the best-scored release differs. Rows marked **tied before** had two or more best candidates with exactly the same old score, so the old pick fell to stored order.',
    '- identify\'s decision is replayed without its check that the chosen release was stored; a pick whose release was missing would go to review instead.',
    '- Fingerprint (AcoustID) auto-accepts happen before this decision and are not replayed.',
    '- **Outcome**: auto = identify takes it; rules = held for review, then taken by the auto-accept rules (only where they are on); review = held for review; unidentified = only weak candidates.',
    '- **Rules** columns show what the saved rules would decide (a dry run, whether or not they are on).',
    '- **Script**: by the letters of the album\'s title and artist guess. latin-ascii = only A–Z; latin-accented = Latin with any non-ASCII letter (accented or full-width); cjk = Han, kana or Hangul; cyrillic; other = any other script; mixed = letters from more than one of these. The main table buckets title and artist together; the two after it bucket each alone.',
    '',
  );
  out.push('## Summary', '');
  out.push('| | |', '|---|---:|');
  out.push(`| albums with stored candidates | ${r.albumsConsidered} |`);
  out.push(`| albums compared | ${r.albumsCompared} |`);
  out.push(`| albums with any change | ${r.rows.length} |`);
  out.push(`| top candidate changes | ${r.topChanges} |`);
  out.push(`| of those, tied before | ${r.rows.filter((x) => x.tiedBefore && x.top.before.releaseId !== x.top.after.releaseId).length} |`);
  out.push(`| identify decision changes | ${Object.values(r.identifyChanges).reduce((a, b) => a + b, 0)} |`);
  out.push(`| outcome changes | ${Object.values(r.outcomeChanges).reduce((a, b) => a + b, 0)} |`);
  out.push(`| changed albums matched automatically today | ${r.liveMatchAffected.length} |`);
  out.push(`| skipped: no tracks | ${r.skipped.noTracks} |`);
  out.push(`| not replayable (a candidate has no stored tracks) | ${r.notReplayable.length} |`);
  out.push(`| libraries with auto-accept rules on | ${r.rulesEnabledLibraries} |`, '');
  out.push('### Changes by script (title and artist)', '', bucketTable(r.byBucket));
  out.push('### Changes by script of the title', '', bucketTable(r.byTitleBucket));
  out.push('### Changes by script of the artist', '', bucketTable(r.byArtistBucket));
  out.push('### Outcome changes', '', countTable(r.outcomeChanges));
  out.push('### Identify decision changes', '', countTable(r.identifyChanges));
  out.push('### Auto-accept rules changes', '', countTable(r.rulesChanges));

  for (const b of SCRIPT_BUCKETS) {
    const rows = r.rows.filter((x) => x.bucket.album === b);
    out.push(`## ${b} (${rows.length})`, '');
    if (rows.length === 0) { out.push('_none_', ''); continue; }
    out.push('| album id | artist | title | state | top before | top after | tied before | identify | rules | outcome | live |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of rows) {
      const same = x.top.before.releaseId === x.top.after.releaseId;
      const top = (p: TopPick) => `${cell(p.title)} (${p.distance.toFixed(4)})`;
      out.push(`| ${x.albumId} | ${cell(x.artist)} | ${cell(x.title)} | ${x.state} | ${top(x.top.before)} | ${same ? 'same' : top(x.top.after)} | ${x.tiedBefore ? 'yes' : ''} | ${x.identify.before} → ${x.identify.after} | ${x.rules.before} → ${x.rules.after} | ${x.outcome.before} → ${x.outcome.after} | ${x.live ? 'yes' : ''} |`);
    }
    out.push('');
  }
  out.push(`## Not replayable (${r.notReplayable.length})`, '');
  if (r.notReplayable.length === 0) out.push('_none_', '');
  else {
    out.push('| album id | artist | title | releases without stored tracks |', '|---|---|---|---|');
    for (const x of r.notReplayable) out.push(`| ${x.albumId} | ${cell(x.artist)} | ${cell(x.title)} | ${x.releaseIds.join(', ')} |`);
    out.push('');
  }
  return out.join('\n');
}

export const USAGE = 'usage: normalisationRegression [--library <id>] [--limit <positive integer>] [--out <report.md>] [--json <report.json>]';

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli) { console.error(USAGE); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { ctx, close } = await regressionContext(url);
  try {
    const r = await normalisationRegression(ctx, { ...(cli.library ? { libraryId: cli.library } : {}), ...(cli.limit ? { limit: cli.limit } : {}) });
    console.log(`albums with stored candidates: ${r.albumsConsidered}, compared: ${r.albumsCompared}`);
    console.log(`albums with any change: ${r.rows.length} (top candidate: ${r.topChanges}; matched automatically today: ${r.liveMatchAffected.length})`);
    console.log(`outcome changes: ${JSON.stringify(r.outcomeChanges)}`);
    console.log(`not replayable: ${r.notReplayable.length}`);
    if (cli.out) await writeFile(cli.out, renderNormalisationReport(r));
    if (cli.json) await writeFile(cli.json, JSON.stringify(r, null, 2));
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}

/**
 * Read-only report: which albums the barcode fix would decide differently.
 *
 * For every album with stored candidates, each candidate release is rebuilt
 * from the stored rows and scored twice against the album's files:
 *
 * - before: the scorer with the files' barcode taken out, then the old
 *   breakdown rule put back (barcodes compared as written; a match wrote
 *   albumId 0, a mismatch added 0.3; neither touched the distance);
 * - after: the current scorer (barcodes compared normalised; a mismatch
 *   counts in the distance).
 *
 * Both sides use the same rebuilt release, so the only difference is the
 * barcode rule. Identify's own decision and the library's auto-accept rules
 * are replayed on both. Nothing is written.
 *
 *   DATABASE_URL=postgres://… node packages/worker/dist/barcodeRegression.js \
 *     [--library <id>] [--limit N] [--out <report.md>] [--json <report.json>]
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import type { PgBoss } from 'pg-boss';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { localAlbums, localTracks, makeDb, fetchAutoAcceptRulesRow } from '@tagave/db';
import { scoreRelease, evaluateAutoAccept, rulesFromStored, mediumCountOf, normalizeBarcode } from '@tagave/core';
import type { WorkerContext } from './lib/context.js';
import { localViewOf, toScorable } from './jobs/identifyAlbum.js';
import { storedReleases, type StoredRelease } from './lib/storedRelease.js';
import { identifyDecision } from './lib/identifyDecision.js';

/** How a candidate's stored barcode compares with the files' barcode. */
export type BarcodeKind = 'match' | 'format_only' | 'mismatch' | 'unusable' | 'not_stored';
/** auto: identify takes it; rules: held, then the enabled rules take it; review; unidentified. */
export type Outcome = 'auto' | 'rules' | 'review' | 'unidentified';

export interface RegressionRow {
  albumId: string;
  state: string;
  identify: { before: string; after: string };
  rules: { before: string; after: string };
  title: string | null;
  artist: string | null;
  outcome: { before: Outcome; after: Outcome };
  /**
   * What drives the change: a real mismatch, a barcode written differently
   * (or not readable as one), or a matching barcode that no longer paints
   * over a mismatching embedded release id.
   */
  cause: 'mismatch' | 'format_only' | 'embedded_id';
  /** matched automatically today */
  live: boolean;
  /** the rebuilt artist term differs from the one stored at identify time */
  artistDrift: boolean;
}

export interface NotReplayable { albumId: string; title: string | null; artist: string | null; releaseIds: string[] }

export interface RegressionReport {
  /** albums with candidates that were looked at */
  albumsConsidered: number;
  /** albums replayed: files and at least one stored candidate carry a barcode */
  albumsCompared: number;
  identifyChanges: Record<string, number>;
  rulesChanges: Record<string, number>;
  outcomeChanges: Record<string, number>;
  /** changed albums only */
  rows: RegressionRow[];
  liveMatchAffected: string[];
  /** candidates of compared albums and of albums with no stored barcode */
  candidates: Record<BarcodeKind, number>;
  skipped: { noTracks: number; noFileBarcode: number; notStored: number };
  /** a candidate release has no stored tracks (or no stored row): not scored */
  notReplayable: NotReplayable[];
  /** libraries whose auto-accept rules are switched on */
  rulesEnabledLibraries: number;
}

/** Albums per round trip: bounded memory on a large library. */
const BATCH = 200;
/** An artist term this far from the stored one counts as drift. */
const ARTIST_EPSILON = 1e-4;

type AlbumRow = typeof localAlbums.$inferSelect;
type TrackRow = typeof localTracks.$inferSelect;
type CandRow = { local_album_id: string; release_id: string; distance: string; breakdown: unknown };
type Scored = { dbId: string; distance: number; breakdown: Record<string, unknown> };

export function barcodeKind(localRaw: string, candidateRaw: string | undefined): BarcodeKind {
  if (!candidateRaw) return 'not_stored';
  if (localRaw === candidateRaw) return 'match';
  const l = normalizeBarcode(localRaw); const c = normalizeBarcode(candidateRaw);
  if (!l || !c) return 'unusable';
  return l === c ? 'format_only' : 'mismatch';
}

/** The breakdown rule before the fix: barcodes as written, chips only. */
function legacyBreakdown(breakdown: Record<string, unknown>, localRaw: string, candidateRaw: string | undefined): Record<string, unknown> {
  if (!localRaw || !candidateRaw) return breakdown;
  const prev = typeof breakdown['albumId'] === 'number' ? (breakdown['albumId'] as number) : 0;
  return { ...breakdown, albumId: localRaw === candidateRaw ? 0 : prev + 0.3 };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const byDistance = (a: Scored, b: Scored) => a.distance - b.distance;

export async function barcodeRegression(ctx: WorkerContext, opts: { libraryId?: string; limit?: number; batchSize?: number } = {}): Promise<RegressionReport> {
  const report: RegressionReport = {
    albumsConsidered: 0, albumsCompared: 0, identifyChanges: {}, rulesChanges: {}, outcomeChanges: {}, rows: [], liveMatchAffected: [],
    candidates: { match: 0, format_only: 0, mismatch: 0, unusable: 0, not_stored: 0 },
    skipped: { noTracks: 0, noFileBarcode: 0, notStored: 0 }, notReplayable: [], rulesEnabledLibraries: 0,
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
  ctx: WorkerContext, albums: AlbumRow[], report: RegressionReport, rulesByLibrary: Map<string, ReturnType<typeof rulesFromStored>>,
): Promise<void> {
  const ids = albums.map((a) => a.id);
  // one text parameter for the whole batch, never one per id
  const idArray = sql`string_to_array(${ids.join(',')}, ',')::uuid[]`;
  const trackRows: TrackRow[] = await ctx.db.select().from(localTracks).where(sql`${localTracks.localAlbumId} = any(${idArray})`);
  const tracksBy = groupBy(trackRows, (t) => t.localAlbumId ?? '');
  const candRows = await ctx.sql<CandRow[]>`
    select local_album_id, release_id, distance::text as distance, breakdown from match_candidates
     where local_album_id = any(${ids}::uuid[]) and source not like 'mc:%' and excluded is not true
     order by local_album_id, distance, release_id`;
  const candsBy = groupBy(candRows, (c) => c.local_album_id);
  const liveRows = await ctx.sql<Array<{ local_album_id: string }>>`
    select distinct local_album_id from album_matches
     where local_album_id = any(${ids}::uuid[]) and status in ('auto', 'confirmed') and decided_by = 'system'`;
  const live = new Set(liveRows.map((r) => r.local_album_id));
  const stored = await storedReleases(ctx, [...new Set(candRows.map((c) => c.release_id))]);

  for (const album of albums) {
    const tracks = tracksBy.get(album.id) ?? [];
    if (tracks.length === 0) { report.skipped.noTracks += 1; continue; }
    const { local } = await localViewOf(ctx, album, tracks);
    const localRaw = local.barcode;
    if (!localRaw) { report.skipped.noFileBarcode += 1; continue; }
    const cands = candsBy.get(album.id) ?? [];
    const missing = cands.filter((c) => !stored.get(c.release_id)?.complete).map((c) => c.release_id);
    if (missing.length > 0) {
      report.notReplayable.push({ albumId: album.id, title: album.titleGuess, artist: album.artistGuess, releaseIds: missing });
      continue;
    }
    const releases = cands.map((c) => stored.get(c.release_id)!);
    const kinds = releases.map((s) => barcodeKind(localRaw, s.release.barcode));
    for (const k of kinds) report.candidates[k] += 1;
    if (kinds.every((k) => k === 'not_stored')) { report.skipped.notStored += 1; continue; }
    report.albumsCompared += 1;

    const { barcode: _drop, ...noBarcode } = local;
    const before: Scored[] = []; const afterList: Scored[] = [];
    let artistDrift = false;
    releases.forEach((s, i) => {
      const scorable = toScorable(s.release);
      const b = scoreRelease(noBarcode, scorable);
      before.push({ dbId: s.dbId, distance: b.distance, breakdown: legacyBreakdown(b.breakdown as Record<string, unknown>, localRaw, s.release.barcode) });
      const a = scoreRelease(local, scorable);
      afterList.push({ dbId: s.dbId, distance: a.distance, breakdown: a.breakdown as Record<string, unknown> });
      const storedArtist = (cands[i]!.breakdown as Record<string, unknown> | null)?.['artist'];
      if (typeof storedArtist === 'number' && typeof a.breakdown.artist === 'number'
        && Math.abs(storedArtist - a.breakdown.artist) > ARTIST_EPSILON) artistDrift = true;
    });
    before.sort(byDistance); afterList.sort(byDistance);

    const relOf = new Map<string, StoredRelease>(releases.map((s) => [s.dbId, s]));
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
      const st = relOf.get(s.dbId)!; const r = st.release;
      return {
        id: s.dbId, distance: s.distance, breakdown: s.breakdown, provider: r.source, status: st.status,
        title: r.title, artist: r.artists.join(', ') || null, date: r.year ? String(r.year) : null,
        country: r.country ?? null, trackCount: r.tracks.length,
      };
    })).accept ? 'accept' : 'no';
    const outcomeOf = (kind: string, rule: string): Outcome =>
      kind === 'strong' || kind === 'chip_rule' || kind === 'first_candidate' ? 'auto'
        : kind === 'held' ? (rules.enabled && rule === 'accept' ? 'rules' : 'review')
          : 'unidentified';

    const idB = decide(before); const idA = decide(afterList);
    const ruB = byRules(before); const ruA = byRules(afterList);
    if (idB === idA && ruB === ruA) continue;
    const row: RegressionRow = {
      albumId: album.id, state: album.state, title: album.titleGuess, artist: album.artistGuess,
      identify: { before: idB, after: idA }, rules: { before: ruB, after: ruA },
      outcome: { before: outcomeOf(idB, ruB), after: outcomeOf(idA, ruA) },
      cause: kinds.includes('mismatch') ? 'mismatch' : kinds.includes('format_only') || kinds.includes('unusable') ? 'format_only' : 'embedded_id',
      live: live.has(album.id), artistDrift,
    };
    if (idB !== idA) bump(report.identifyChanges, `${idB}→${idA}`);
    if (ruB !== ruA) bump(report.rulesChanges, `${ruB}→${ruA}`);
    if (row.outcome.before !== row.outcome.after) bump(report.outcomeChanges, `${row.outcome.before}→${row.outcome.after}`);
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

const cell = (v: string | null | undefined) => (v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const countTable = (m: Record<string, number>) => {
  const keys = Object.keys(m).sort();
  if (keys.length === 0) return '_none_\n';
  return ['| change | albums |', '|---|---:|', ...keys.map((k) => `| ${k} | ${m[k]} |`)].join('\n') + '\n';
};

const CAUSE_TITLE: Record<RegressionRow['cause'], string> = {
  mismatch: 'Real barcode mismatch',
  format_only: 'Same barcode written differently (formatting only)',
  embedded_id: 'Matching barcode over a mismatching embedded release id',
};

/**
 * The report as Markdown. It carries album ids, titles and artists only, so
 * it can be shared: no file names, folders or library settings.
 */
export function renderRegressionReport(r: RegressionReport, generatedAt = new Date()): string {
  const out: string[] = [];
  out.push('# Barcode fix: regression report', '');
  out.push(`Generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Read-only replay; nothing was written.`, '');
  out.push('## How to read this', '');
  out.push(
    '- **before**: the scorer with the files\' barcode removed and the old rule put back (barcodes compared as written; a match set the album-id chip green, a mismatch made it red; the distance never changed).',
    '- **after**: the current scorer (barcodes compared as digits, a 12-digit UPC-A read as EAN-13; a mismatch adds to the distance).',
    '- Both sides score the same candidate releases, rebuilt from what was stored when the album was identified. A stored release keeps what its first fetch saw: a candidate whose stored release has no barcode is counted as "not stored" and never as a change.',
    '- The artist term reads the release group\'s artist credit, not the release\'s own. Rows marked **artist drift** have a rebuilt artist term that differs from the one stored at identify time, so their before/after may not be exactly what identify would do.',
    '- identify\'s decision is replayed without its check that the chosen release was stored; a pick whose release was missing would go to review instead.',
    '- Fingerprint (AcoustID) auto-accepts happen before this decision and are not replayed.',
    '- **Outcome**: auto = identify takes it; rules = held for review, then taken by the auto-accept rules (only where they are on); review = held for review; unidentified = only weak candidates.',
    '- **Rules** columns show what the saved rules would decide (a dry run, whether or not they are on).',
    '',
  );
  out.push('## Summary', '');
  out.push('| | |', '|---|---:|');
  out.push(`| albums with stored candidates | ${r.albumsConsidered} |`);
  out.push(`| albums compared | ${r.albumsCompared} |`);
  out.push(`| albums whose decision changes | ${r.rows.length} |`);
  out.push(`| of those, matched automatically today | ${r.liveMatchAffected.length} |`);
  out.push(`| of those, with artist drift | ${r.rows.filter((x) => x.artistDrift).length} |`);
  out.push(`| skipped: no tracks | ${r.skipped.noTracks} |`);
  out.push(`| skipped: files carry no barcode | ${r.skipped.noFileBarcode} |`);
  out.push(`| skipped: no stored candidate barcode | ${r.skipped.notStored} |`);
  out.push(`| not replayable (a candidate has no stored tracks) | ${r.notReplayable.length} |`);
  out.push(`| libraries with auto-accept rules on | ${r.rulesEnabledLibraries} |`, '');
  out.push('### Candidates by barcode', '');
  out.push('| barcode | candidates |', '|---|---:|');
  out.push(`| same | ${r.candidates.match} |`, `| same, written differently | ${r.candidates.format_only} |`, `| different | ${r.candidates.mismatch} |`,
    `| not readable as a barcode | ${r.candidates.unusable} |`, `| not stored | ${r.candidates.not_stored} |`, '');
  out.push('### Outcome changes', '', countTable(r.outcomeChanges));
  out.push('### Identify decision changes', '', countTable(r.identifyChanges));
  out.push('### Auto-accept rules changes', '', countTable(r.rulesChanges));

  for (const cause of ['mismatch', 'format_only', 'embedded_id'] as const) {
    const rows = r.rows.filter((x) => x.cause === cause);
    out.push(`## ${CAUSE_TITLE[cause]} (${rows.length})`, '');
    if (rows.length === 0) { out.push('_none_', ''); continue; }
    out.push('| album id | artist | title | state | identify | rules | outcome | live | artist drift |', '|---|---|---|---|---|---|---|---|---|');
    for (const x of rows) {
      out.push(`| ${x.albumId} | ${cell(x.artist)} | ${cell(x.title)} | ${x.state} | ${x.identify.before} → ${x.identify.after} | ${x.rules.before} → ${x.rules.after} | ${x.outcome.before} → ${x.outcome.after} | ${x.live ? 'yes' : ''} | ${x.artistDrift ? 'yes' : ''} |`);
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const library = arg('--library'); const limit = arg('--limit');
  const { db, client } = await makeDb(url);
  const ctx: WorkerContext = { db, sql: client, boss: {} as PgBoss, logger: pino({ level: 'warn' }) };
  try {
    const r = await barcodeRegression(ctx, { ...(library ? { libraryId: library } : {}), ...(limit ? { limit: Number(limit) } : {}) });
    console.log(`albums with stored candidates: ${r.albumsConsidered}, compared: ${r.albumsCompared}`);
    console.log(`decisions that change: ${r.rows.length} (matched automatically today: ${r.liveMatchAffected.length})`);
    console.log(`outcome changes: ${JSON.stringify(r.outcomeChanges)}`);
    console.log(`not replayable: ${r.notReplayable.length}`);
    const md = arg('--out'); const json = arg('--json');
    if (md) await writeFile(md, renderRegressionReport(r));
    if (json) await writeFile(json, JSON.stringify(r, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}

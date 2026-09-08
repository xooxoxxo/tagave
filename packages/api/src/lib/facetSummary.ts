/**
 * XO-363: facet counts from the worker-maintained album_facets table.
 *
 * album_facets holds one narrow row per album (state, format, containers,
 * decade, labels, genres, open gap kinds, owned, decided); the file worker's
 * facets.refresh job rebuilds it whenever albums, gaps or the collection
 * change. Requests whose filters are all covered by those columns aggregate
 * this table instead of joining six tables per dimension — a few tens of
 * milliseconds for 28k albums. Anything else (free text, artist, review or
 * decided filters) keeps the live path in routes/albums.ts, as does a library
 * whose summary is missing or marked dirty by a bulk action.
 */
import { and, sql, type SQL } from 'drizzle-orm';
import { getBoss } from '../boss.js';
import type { getDb } from '../db.js';

type Db = ReturnType<typeof getDb>;
type Row = Record<string, string | number | null>;

const SUMMARY_KEYS = new Set(['state', 'filter', 'genre', 'decade', 'format', 'label', 'owned', 'gap']);
const IGNORED_KEYS = new Set(['sort', 'order', 'page', 'limit', 'offset', 'cursor', 'view', 'pageSize']);
const FORMAT_CLASSES = new Set(['lossless', 'lossy', 'mixed']);
const DECIDED_KEYS = ['auto_strong', 'chip_rule', 'first_candidate', 'by_me', 'manual_mbid'] as const;

export type FacetDim = 'state' | 'genre' | 'decade' | 'format' | 'label' | 'gap';

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Every filter in the request is one album_facets can answer. */
export function summaryEligible(rawQuery: Record<string, unknown>): boolean {
  return Object.entries(rawQuery).every(([k, v]) => IGNORED_KEYS.has(k) || empty(v) || SUMMARY_KEYS.has(k));
}

/** A build exists and no bulk action has stamped the library dirty since. */
export async function summaryFresh(db: Db, libraryId: string): Promise<boolean> {
  const rows = (await db.execute(sql`select computed_at, dirty_at from facet_state where library_id = ${libraryId}`)) as unknown as Array<{
    computed_at: Date | string | null; dirty_at: Date | string | null;
  }>;
  const st = rows[0];
  if (!st?.computed_at) return false;
  if (!st.dirty_at) return true;
  return new Date(st.dirty_at).getTime() <= new Date(st.computed_at).getTime();
}

/**
 * Stamp the library's summary stale and ask the worker for a rebuild. Until
 * the rebuild lands the facets endpoint answers from the live queries.
 */
export async function markFacetsDirty(db: Db, libraryId: string): Promise<void> {
  await db.execute(sql`
    insert into facet_state (library_id, dirty_at) values (${libraryId}, now())
    on conflict (library_id) do update set dirty_at = now()`);
  try {
    const boss = await getBoss();
    await boss.createQueue('facets.refresh');
    await boss.send('facets.refresh', { libraryId }, { singletonKey: `facets:${libraryId}` });
  } catch {
    // the every-minute schedule on the worker picks the change up anyway
  }
}

/** Filter predicates over album_facets `af`, mirroring albumQueryParts() for the covered keys. */
export function summaryConds(libraryId: string, rawQuery: Record<string, unknown>, omit?: FacetDim): SQL[] {
  const q = (omit ? { ...rawQuery, [omit]: undefined, ...(omit === 'state' ? { filter: undefined } : {}) } : rawQuery) as Record<string, unknown>;
  const arr = (v: unknown): string[] => (empty(v) ? [] : (Array.isArray(v) ? v : [v]).map(String).filter((s) => s !== ''));
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
  const inList = (values: Array<string | number>) => sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
  const anyOf = (parts: SQL[]) => sql`(${sql.join(parts, sql` or `)})`;

  const out: SQL[] = [sql`af.library_id = ${libraryId}`];
  const states = arr(q['state'] ?? q['filter']).filter((s) => s !== 'all');
  if (states.length) out.push(sql`af.state in ${inList(states)}`);
  const genres = arr(q['genre']);
  if (genres.length) out.push(sql`af.genres && ${genres}::text[]`);
  const decades = arr(q['decade']).map((d) => parseInt(d, 10)).filter(Number.isFinite);
  if (decades.length) out.push(sql`af.decade in ${inList(decades)}`);
  const formats = arr(q['format']);
  if (formats.length) out.push(anyOf(formats.map((f) => (FORMAT_CLASSES.has(f) ? sql`af.format = ${f}` : sql`${f} = any(af.containers)`))));
  const labels = arr(q['label']);
  if (labels.length) out.push(sql`af.labels && ${labels}::text[]`);
  const owned = str(q['owned']);
  if (owned === 'both') out.push(sql`af.owned`);
  else if (owned === 'digital') out.push(sql`not af.owned`);
  const gapKinds = arr(q['gap']);
  if (gapKinds.length) out.push(anyOf(gapKinds.map((g) => (g === 'none' ? sql`cardinality(af.gap_kinds) = 0` : sql`${g} = any(af.gap_kinds)`))));
  return out;
}

/** Same response shape as the live facets handler. */
export async function summaryFacets(db: Db, libraryId: string, userId: string, rawQuery: Record<string, unknown>) {
  const where = (omit?: FacetDim) => and(...summaryConds(libraryId, rawQuery, omit))!;
  const rows = async (query: SQL) => (await db.execute(query)) as unknown as Row[];
  const facet = (list: Row[], key: string, label?: (v: string) => string) =>
    list.filter((r) => r[key] != null).map((r) => ({
      value: String(r[key]), ...(label ? { label: label(String(r[key])) } : {}), count: Number(r['n']),
    }));
  const ownReview = sql`ur.library_id = af.library_id and ur.release_group_id = af.release_group_id and ur.user_id = ${userId}`;
  const listensWhere = sql`l.library_id = af.library_id and l.release_group_id = af.release_group_id and l.user_id = ${userId}`;

  const [[totals], states, formats, containers, decades, genres, labels, gapRows, [gapNone]] = await Promise.all([
    rows(sql`
      select count(*)::int as total,
             count(*) filter (where af.owned)::int as owned_both,
             count(*) filter (where exists (select 1 from user_reviews ur where ${ownReview} and coalesce(ur.body_md, '') <> ''))::int as reviewed,
             count(*) filter (where exists (select 1 from user_reviews ur where ${ownReview} and ur.rating is not null))::int as rated,
             count(*) filter (where exists (select 1 from listens l where ${listensWhere}))::int as listened,
             count(*) filter (where cardinality(af.gap_kinds) = 0)::int as no_gap,
             ${sql.join(DECIDED_KEYS.map((k) => sql`count(*) filter (where ${k} = any(af.decided))::int as ${sql.raw(`decided_${k}`)}`), sql`, `)}
      from album_facets af where ${where()}`),
    rows(sql`select af.state, count(*)::int as n from album_facets af where ${where('state')} group by 1 order by n desc`),
    rows(sql`select af.format as k, count(*)::int as n from album_facets af where ${where('format')} group by 1 order by n desc`),
    rows(sql`select f, count(*)::int as n from album_facets af, unnest(af.containers) f where ${where('format')} group by f order by n desc limit 12`),
    rows(sql`select af.decade, count(*)::int as n from album_facets af where ${where('decade')} and af.decade between 1900 and 2100 group by 1 order by 1`),
    rows(sql`select t as tag, count(*)::int as n from album_facets af, unnest(af.genres) t where ${where('genre')} group by t order by n desc, t limit 60`),
    rows(sql`select l as name, count(*)::int as n from album_facets af, unnest(af.labels) l where ${where('label')} group by l order by n desc, l limit 60`),
    rows(sql`select k as kind, count(*)::int as n from album_facets af, unnest(af.gap_kinds) k where ${where('gap')} group by k order by n desc`),
    rows(sql`select count(*)::int as n from album_facets af where ${where('gap')} and cardinality(af.gap_kinds) = 0`),
  ]);
  const total = Number(totals?.['total'] ?? 0);
  const n = (k: string) => Number(totals?.[k] ?? 0);
  return {
    total,
    states: facet(states, 'state'),
    formats: facet(formats, 'k'),
    containers: facet(containers, 'f'),
    decades: facet(decades, 'decade', (d) => `${d}s`),
    genres: facet(genres, 'tag'),
    labels: facet(labels, 'name'),
    review: [
      { value: 'reviewed', count: n('reviewed') }, { value: 'unreviewed', count: total - n('reviewed') },
      { value: 'rated', count: n('rated') }, { value: 'listened', count: n('listened') },
    ],
    gaps: [...facet(gapRows, 'kind'), { value: 'none', count: Number(gapNone?.['n'] ?? 0) }],
    owned: [{ value: 'both', count: n('owned_both') }, { value: 'digital', count: total - n('owned_both') }],
    decided: DECIDED_KEYS.map((k) => ({ value: k, count: n(`decided_${k}`) })),
  };
}

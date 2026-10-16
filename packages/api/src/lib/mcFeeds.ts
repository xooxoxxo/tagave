/**
 * Music Connections feeds (spec §3): what tagave serves at /mc/v1/<capability>.
 * The change log (mc_changes, migration 0048, written by triggers) says which
 * keys changed and in what order; each item's data is built here from the
 * current rows when the page is read, so a page never carries a stale value.
 *
 * Everything is scoped to one person and one library (scopeFor): ratings and
 * listens are that person's own rows; collection and identity describe the
 * library, which every account on the install reads (0043).
 *
 * No prose crosses: a rating carries rating, rating_raw, scale, favorite and
 * rated_at, never the review's text (user_reviews.body_md).
 */
import type postgres from 'postgres';
import { AlbumRefSchema, CAPABILITY_DATA, CursorError, decodeCursor, type Capability } from 'music-connections';

type Sql = postgres.Sql;

/** Tombstones are kept this long (mc.purge); a cursor older than this is 410. */
export const TOMBSTONE_DAYS = 90;
export const MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Pure mappings (unit-tested) ────────────────────────────────────────────

/**
 * Tagave rates 0.5–5 in half steps (user_reviews.rating, numeric(2,1));
 * the protocol is 0–10. 3.5 → { rating: 7, rating_raw: "3.5" }. Null (a
 * cleared rating) has no mapping: that key is a tombstone, never a 0.
 */
export function mapRating(stored: string | number | null | undefined): { rating: number; rating_raw: string; scale: '0-5' } | null {
  if (stored === null || stored === undefined || stored === '') return null;
  const value = Number(stored);
  if (!Number.isFinite(value) || value <= 0 || value > 5) return null;
  return { rating: value * 2, rating_raw: String(value), scale: '0-5' };
}

export type FormatKind = 'vinyl' | 'cd' | 'cassette' | 'digital' | 'other';
export interface FormatEntry { kind: FormatKind; detail?: string }

/** A Discogs format name as a protocol kind: Vinyl, CD, Cassette, File; anything else is other. */
export function discogsFormatKind(name: unknown): FormatKind {
  switch (typeof name === 'string' ? name.trim().toLowerCase() : '') {
    case 'vinyl': return 'vinyl';
    case 'cd': return 'cd';
    case 'cassette': return 'cassette';
    case 'file': return 'digital';
    default: return 'other';
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * The formats of one album: each Discogs copy's formats (kind from the name,
 * its descriptions as the detail) and one digital entry per codec of the
 * local files. A copy whose formats Discogs left empty still counts (other).
 * Duplicates collapse; at most 50 (the schema's bound).
 */
export function collectionFormats(discogsCopies: unknown[], localCodecs: Array<string | null>): FormatEntry[] {
  const out: FormatEntry[] = [];
  const seen = new Set<string>();
  const add = (e: FormatEntry) => {
    const id = `${e.kind}\u0000${e.detail ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(e);
  };
  for (const copy of discogsCopies) {
    const formats = Array.isArray(copy) ? copy : [];
    if (formats.length === 0) add({ kind: 'other' });
    for (const f of formats) {
      const rec = (f && typeof f === 'object' ? f : {}) as { name?: unknown; descriptions?: unknown };
      const descriptions = Array.isArray(rec.descriptions) ? rec.descriptions.filter((d): d is string => typeof d === 'string' && d.trim() !== '') : [];
      const detail = clip(descriptions.join(', '), 120);
      add({ kind: discogsFormatKind(rec.name), ...(detail ? { detail } : {}) });
    }
  }
  for (const codec of localCodecs) {
    const detail = typeof codec === 'string' ? clip(codec.trim(), 120) : '';
    add({ kind: 'digital', ...(detail ? { detail } : {}) });
  }
  return out.slice(0, 50);
}

export type Provenance = 'manual' | 'embedded' | 'auto';

/**
 * How sure tagave is of an album's release: confirmed by a person (manual),
 * read from the files' own MusicBrainz tags (embedded), or matched by the
 * identifier (auto, confidence 1 − distance).
 */
export function identityProvenance(m: {
  status: string | null;
  source: string | null;
  distance: number | string | null;
  embeddedMbid: string | null;
  releaseMbid: string | null;
}): { provenance: Provenance; confidence: number } {
  if (m.status === 'confirmed') return { provenance: 'manual', confidence: 1 };
  const embedded = m.embeddedMbid && m.releaseMbid && m.embeddedMbid.toLowerCase() === m.releaseMbid.toLowerCase();
  if (m.source === 'mbid' || embedded) return { provenance: 'embedded', confidence: 1 };
  const d = m.distance === null ? NaN : Number(m.distance);
  const confidence = Number.isFinite(d) ? Math.min(1, Math.max(0, 1 - d)) : 0;
  return { provenance: 'auto', confidence: Math.round(confidence * 10000) / 10000 };
}

// ── Album identity (every item's `album`) ──────────────────────────────────

export interface AlbumRef {
  rg_mbid: string | null;
  release_mbid?: string;
  discogs_master_id?: number;
  discogs_release_id?: number;
  artist: string;
  title: string;
}

const validUuid = (s: unknown): s is string => typeof s === 'string' && AlbumRefSchema.shape.release_mbid.safeParse(s.toLowerCase()).success;
const positiveInt = (n: unknown): number | undefined => {
  const v = typeof n === 'string' ? Number(n) : n;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
};

export function albumRef(p: {
  rgMbid: string | null;
  releaseMbid?: string | null;
  discogsMasterId?: unknown;
  discogsReleaseId?: unknown;
  artist: string | null;
  title: string | null;
}): AlbumRef {
  const master = positiveInt(p.discogsMasterId);
  const release = positiveInt(p.discogsReleaseId);
  return {
    rg_mbid: validUuid(p.rgMbid) ? p.rgMbid.toLowerCase() : null,
    ...(validUuid(p.releaseMbid) ? { release_mbid: p.releaseMbid.toLowerCase() } : {}),
    ...(master !== undefined ? { discogs_master_id: master } : {}),
    ...(release !== undefined ? { discogs_release_id: release } : {}),
    artist: clip(p.artist ?? '', 300),
    title: clip(p.title ?? '', 300),
  };
}

/**
 * The album identity of release groups, as this library knows them: the
 * group's MBID and Discogs ids, the release of its matched album (or of a
 * Discogs copy), and an artist from the group's credit, else the album's
 * tags, else the copy's Discogs artists.
 */
export async function albumRefs(sql: Sql, libraryId: string, rgIds: string[]): Promise<Map<string, AlbumRef>> {
  const out = new Map<string, AlbumRef>();
  if (rgIds.length === 0) return out;
  const rows = await sql<Array<{
    id: string; mbid: string | null; title: string; rg_master: number | null; rg_release: number | null; credit: string | null;
    la_artist: string | null; la_release_mbid: string | null;
    ci_master: number | null; ci_release: number | null; ci_release_mbid: string | null; ci_artists: string | null;
  }>>`
    select rg.id::text as id, rg.mbid, rg.title, rg.discogs_master_id as rg_master, rg.discogs_release_id as rg_release,
           case when jsonb_typeof(rg.artist_credit) = 'array'
                then (select string_agg(x, ', ') from jsonb_array_elements_text(rg.artist_credit) x) end as credit,
           la.artist_guess as la_artist, la.release_mbid as la_release_mbid,
           ci.discogs_master_id as ci_master, ci.discogs_release_id as ci_release, ci.release_mbid as ci_release_mbid, ci.artists as ci_artists
      from release_groups rg
      left join lateral (
        select a.artist_guess, r.mbid as release_mbid
          from local_albums a left join releases r on r.id = a.release_id
         where a.library_id = ${libraryId} and a.release_group_id = rg.id and a.state = 'matched'
         order by a.preferred desc nulls last, a.created_at, a.id
         limit 1) la on true
      left join lateral (
        select c.discogs_master_id, c.discogs_release_id, r.mbid as release_mbid,
               case when jsonb_typeof(c.basic_info->'artists') = 'array'
                    then (select string_agg(x, ', ') from jsonb_array_elements_text(c.basic_info->'artists') x) end as artists
          from collection_items c left join releases r on r.id = c.release_id
         where c.library_id = ${libraryId} and c.release_group_id = rg.id and c.removed_at is null
         order by c.date_added nulls last, c.id
         limit 1) ci on true
     where rg.id = any(${rgIds}::uuid[])`;
  for (const r of rows) {
    out.set(r.id, albumRef({
      rgMbid: r.mbid,
      releaseMbid: r.la_release_mbid ?? r.ci_release_mbid,
      discogsMasterId: r.rg_master ?? r.ci_master,
      discogsReleaseId: r.rg_release ?? r.ci_release,
      artist: r.credit || r.la_artist || r.ci_artists,
      title: r.title,
    }));
  }
  return out;
}

// ── Payloads per capability ────────────────────────────────────────────────

export interface FeedScope { userId: string; libraryId: string }

const uuidKeys = (keys: string[]) => [...new Set(keys.filter((k) => UUID_RE.test(k)).map((k) => k.toLowerCase()))];

async function ratingsData(sql: Sql, scope: FeedScope, keys: string[]): Promise<Map<string, unknown>> {
  const ids = uuidKeys(keys);
  const out = new Map<string, unknown>();
  if (ids.length === 0) return out;
  const [rows, refs] = await Promise.all([
    sql<Array<{ key: string; rating: string; updated_at: Date }>>`
      select distinct on (release_group_id) release_group_id::text as key, rating::text as rating, updated_at
        from user_reviews
       where library_id = ${scope.libraryId} and user_id = ${scope.userId}
         and release_group_id = any(${ids}::uuid[]) and rating is not null
       order by release_group_id, updated_at desc, id`,
    albumRefs(sql, scope.libraryId, ids),
  ]);
  for (const r of rows) {
    const mapped = mapRating(r.rating);
    const album = refs.get(r.key);
    if (!mapped || !album) continue;
    out.set(r.key, { album, ...mapped, favorite: false, rated_at: r.updated_at.toISOString() });
  }
  return out;
}

async function collectionData(sql: Sql, scope: FeedScope, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const ids = uuidKeys(keys);
  const others = [...new Set(keys.filter((k) => !UUID_RE.test(k)))];
  const [copies, locals, loose, refs] = await Promise.all([
    ids.length === 0 ? [] : sql<Array<{ key: string; formats: unknown; date_added: Date | null }>>`
      select release_group_id::text as key, formats, date_added from collection_items
       where library_id = ${scope.libraryId} and removed_at is null and release_group_id = any(${ids}::uuid[])`,
    ids.length === 0 ? [] : sql<Array<{ key: string; codecs: Array<string | null> }>>`
      select a.release_group_id::text as key, array_agg(distinct af.codec) as codecs
        from local_albums a
        join local_tracks lt on lt.local_album_id = a.id
        join audio_files af on af.id = lt.audio_file_id
       where a.library_id = ${scope.libraryId} and a.state = 'matched' and a.release_group_id = any(${ids}::uuid[])
         and af.status not in ('missing', 'archived')
       group by a.release_group_id`,
    // Discogs copies mapped to no release group: keyed by their Discogs release
    others.length === 0 ? [] : sql<Array<{ key: string; formats: unknown; date_added: Date | null; master: number | null; release: number | null; title: string | null; artists: string | null }>>`
      select mc_collection_key(release_group_id, discogs_release_id, id) as key, formats, date_added,
             discogs_master_id as master, discogs_release_id as release, basic_info->>'title' as title,
             case when jsonb_typeof(basic_info->'artists') = 'array'
                  then (select string_agg(x, ', ') from jsonb_array_elements_text(basic_info->'artists') x) end as artists
        from collection_items
       where library_id = ${scope.libraryId} and removed_at is null and release_group_id is null
         and mc_collection_key(release_group_id, discogs_release_id, id) = any(${others}::text[])
       order by date_added nulls last, id`,
    albumRefs(sql, scope.libraryId, ids),
  ]);

  const byKey = new Map<string, { copies: unknown[]; codecs: Array<string | null>; acquired: Date | null; album?: AlbumRef }>();
  const entry = (key: string) => {
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { copies: [], codecs: [], acquired: null }));
    return e;
  };
  const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : a ?? b);
  for (const c of copies) {
    const e = entry(c.key);
    e.copies.push(c.formats);
    e.acquired = earliest(e.acquired, c.date_added);
  }
  for (const l of locals) entry(l.key).codecs.push(...l.codecs);
  for (const c of loose) {
    const e = entry(c.key);
    e.copies.push(c.formats);
    e.acquired = earliest(e.acquired, c.date_added);
    e.album ??= albumRef({ rgMbid: null, discogsMasterId: c.master, discogsReleaseId: c.release, artist: c.artists, title: c.title });
  }
  for (const [key, e] of byKey) {
    const album = e.album ?? refs.get(key);
    const formats = collectionFormats(e.copies, e.codecs);
    if (!album || formats.length === 0) continue;
    out.set(key, { album, formats, ...(e.acquired ? { acquired_at: e.acquired.toISOString() } : {}) });
  }
  return out;
}

const LISTEN_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{4}-\d{2}-\d{2})$/i;

async function listensData(sql: Sql, scope: FeedScope, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const wanted = [...new Set(keys.filter((k) => LISTEN_KEY_RE.test(k)).map((k) => k.toLowerCase()))];
  if (wanted.length === 0) return out;
  const ids = [...new Set(wanted.map((k) => k.slice(0, 36)))];
  const [rows, refs] = await Promise.all([
    sql<Array<{ key: string; rg: string; n: number; formats: string[] }>>`
      select mc_listen_key(release_group_id, listened_at) as key, release_group_id::text as rg, count(*)::int as n,
             coalesce(array_agg(distinct format) filter (where format is not null and format <> ''), '{}') as formats
        from listens
       where library_id = ${scope.libraryId} and user_id = ${scope.userId} and release_group_id = any(${ids}::uuid[])
         and mc_listen_key(release_group_id, listened_at) = any(${wanted}::text[])
       group by 1, 2`,
    albumRefs(sql, scope.libraryId, ids),
  ]);
  for (const r of rows) {
    const album = refs.get(r.rg);
    if (!album) continue;
    out.set(r.key, {
      album,
      date: r.key.slice(37),
      count: r.n,
      formats: [...new Set(r.formats.map((f) => clip(f, 32)))].sort().slice(0, 10),
    });
  }
  return out;
}

async function identityData(sql: Sql, scope: FeedScope, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const ids = uuidKeys(keys);
  if (ids.length === 0) return out;
  const [rows, refs] = await Promise.all([
    sql<Array<{ key: string; embedded_mbid: string | null; release_mbid: string | null; status: string | null; source: string | null; distance: string | null }>>`
      select distinct on (a.release_group_id) a.release_group_id::text as key, a.embedded_mbid, r.mbid as release_mbid,
             m.status, m.source, m.distance::text as distance
        from local_albums a
        left join album_matches m on m.local_album_id = a.id and m.status in ('auto', 'confirmed')
        left join releases r on r.id = coalesce(m.release_id, a.release_id)
       where a.library_id = ${scope.libraryId} and a.state = 'matched' and a.release_group_id = any(${ids}::uuid[])
       order by a.release_group_id, (m.status = 'confirmed') desc nulls last, a.preferred desc nulls last,
                m.distance nulls last, a.created_at, a.id`,
    albumRefs(sql, scope.libraryId, ids),
  ]);
  for (const r of rows) {
    const base = refs.get(r.key);
    if (!base) continue;
    // the release this album is matched to, not just any the library knows
    const { release_mbid: _drop, ...rest } = base;
    const album: AlbumRef = { ...rest, ...(validUuid(r.release_mbid) ? { release_mbid: r.release_mbid.toLowerCase() } : {}) };
    out.set(r.key, {
      album,
      local_key: r.key,
      ...identityProvenance({ status: r.status, source: r.source, distance: r.distance, embeddedMbid: r.embedded_mbid, releaseMbid: r.release_mbid }),
    });
  }
  return out;
}

const BUILDERS: Partial<Record<Capability, (sql: Sql, scope: FeedScope, keys: string[]) => Promise<Map<string, unknown>>>> = {
  ratings: ratingsData,
  collection: collectionData,
  listens: listensData,
  identity: identityData,
};

/** Whether a capability's rows are one person's (true) or the library's (null user). */
export const PERSONAL: ReadonlySet<Capability> = new Set<Capability>(['ratings', 'listens']);

// ── Reading the log ────────────────────────────────────────────────────────

export interface Cursor { t: string; id: string }

export type CursorCheck = { ok: true; after: Cursor | null } | { ok: false; status: 400 | 410 };

/** The `since` parameter: absent (a full snapshot), bad (400), or older than the tombstones (410). */
export function parseSince(since: unknown, now = Date.now()): CursorCheck {
  if (since === undefined || since === '') return { ok: true, after: null };
  if (typeof since !== 'string') return { ok: false, status: 400 };
  let c: Cursor;
  try {
    c = decodeCursor(since);
  } catch (e) {
    if (e instanceof CursorError) return { ok: false, status: 400 };
    throw e;
  }
  // a calendar date that does not exist (JS rolls 02-31 over) and an id that is not a log id
  const ms = Date.parse(c.t);
  if (new Date(ms).toISOString().slice(0, 19) !== c.t.slice(0, 19) || !/^\d{1,18}$/.test(c.id)) return { ok: false, status: 400 };
  if (now - ms > TOMBSTONE_DAYS * 86_400_000) return { ok: false, status: 410 };
  return { ok: true, after: c };
}

export interface FeedRow { id: string; key: string; op: 'upsert' | 'delete'; changed_at: string; data: unknown; skip: boolean }

/** The library a link reads: the install's first, the one the web app opens (useCurrentLibrary). */
export async function feedLibrary(sql: Sql): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`select id from libraries order by created_at, id limit 1`;
  return rows[0]?.id ?? null;
}

/**
 * The next `limit` changes after the cursor (plus one more, so the page knows
 * whether there is more), with data. An upsert whose key has no data now is
 * served as a delete; one whose data fails the capability's schema is left
 * out of the items (the cursor still moves past it).
 *
 * Rows only count once every transaction that could still add an earlier one
 * has finished: the log is ordered by changed_at, and a transaction that
 * commits late would otherwise slip a row in behind a cursor already handed
 * out. So the read stops short of the start of the oldest transaction still
 * writing (all of tagave runs as one database role, which sees them all).
 */
export async function readFeed(
  sql: Sql,
  cap: Capability,
  scope: FeedScope,
  after: Cursor | null,
  limit: number,
  log?: (msg: string) => void,
): Promise<FeedRow[]> {
  const [horizon] = await sql<Array<{ t: string }>>`
    select to_char(least(clock_timestamp(),
             (select min(xact_start) from pg_stat_activity
               where datname = current_database() and backend_xid is not null and pid <> pg_backend_pid()))
           at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  // ::text first: postgres.js would serialise a timestamptz parameter through
  // a JS Date and drop the microseconds the cursor carries.
  const t = after?.t ?? '1970-01-01T00:00:00Z';
  const id = after?.id ?? '0';
  const rows = await sql<Array<{ id: string; key: string; op: 'upsert' | 'delete'; changed_at: string }>>`
    select id::text as id, key, op, to_char(changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as changed_at
      from mc_changes
     where capability = ${cap}
       and ${PERSONAL.has(cap) ? sql`user_id = ${scope.userId}` : sql`user_id is null`}
       and library_id = ${scope.libraryId}
       and (changed_at, id) > (${t}::text::timestamptz, ${id}::text::bigint)
       and changed_at < ${horizon!.t}::text::timestamptz
     order by changed_at, id
     limit ${limit + 1}`;

  const head = rows.slice(0, limit);
  const build = BUILDERS[cap];
  const built = build ? await build(sql, scope, head.filter((r) => r.op === 'upsert').map((r) => r.key)) : new Map<string, unknown>();
  const schema = CAPABILITY_DATA[cap];
  return rows.map((r, i): FeedRow => {
    if (i >= limit || r.op === 'delete') return { ...r, data: null, skip: false };
    const data = built.get(r.key.toLowerCase());
    if (data === undefined) return { ...r, op: 'delete', data: null, skip: false };
    if (!schema.safeParse(data).success) {
      log?.(`mc feed: ${cap} item ${r.key} does not match its schema; left out`);
      return { ...r, data: null, skip: true };
    }
    return { ...r, data, skip: false };
  });
}

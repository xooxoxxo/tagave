import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray, desc, type SQLWrapper } from 'drizzle-orm';
import {
  albumMatches, audioFiles, canonicalTracks, gaps, images, libraries, localAlbums,
  localTracks, matchCandidates, releaseGroups, releases, externalIds, entityTags, userReviews,
  releaseGroupArtists, fieldLocks, auditLog,
} from '@liner/db';
import { parseDiscogsRef, normalizeGenreMap, effectiveGenres } from '@liner/core';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { IDENTIFY_PRIORITY, IDENTIFY_SINGLETON, pendingIdentifyJob, cancelIdentifyJob } from '../lib/identifyRequests.js';
import { mediaSummary, labelSummary } from '../lib/releaseSummary.js';
import { summaryEligible, summaryFresh, summaryFacets } from '../lib/facetSummary.js';
import { ApiError } from '../middleware/errorHandler.js';

/** Containers whose files are lossless regardless of codec; m4a is decided per file (ALAC vs AAC). */
const LOSSLESS_TRACKS = (albumId: SQLWrapper) =>
  sql`select 1 from local_tracks lt join audio_files af on af.id = lt.audio_file_id where lt.local_album_id = ${albumId} and af.lossless`;
const LOSSY_TRACKS = (albumId: SQLWrapper) =>
  sql`select 1 from local_tracks lt join audio_files af on af.id = lt.audio_file_id where lt.local_album_id = ${albumId} and not coalesce(af.lossless, false)`;

/** Match provenance: how the live match was decided (owner audits auto-accepts here). */
const DECIDED_CLAUSES: Record<string, ReturnType<typeof sql>> = {
  auto_strong: sql`am.decided_by = 'system' and am.reason like 'auto-accept:%'`,
  chip_rule: sql`am.decided_by = 'system' and am.reason like 'chip-rule%'`,
  first_candidate: sql`am.decided_by = 'system' and am.reason like 'first-candidate%'`,
  by_me: sql`am.decided_by = 'user' and am.reason not like 'manual MBID%'`,
  manual_mbid: sql`am.reason like 'manual MBID%'`,
};
const decidedExists = (clause: ReturnType<typeof sql>) => sql`exists (
  select 1 from album_matches am
  where am.local_album_id = ${localAlbums.id} and am.status in ('auto', 'confirmed') and ${clause})`;

/**
 * Album grid filters (spec BRW-1) shared by the list and the facets endpoint.
 * Own rating / review state / listens live per release group (REV-3);
 * correlated subqueries keep the drizzle select intact and cost one index
 * probe per row. Query keys mirror `albumsQuerySchema` (`q` ≡ `search`,
 * `state` ≡ `filter` for older clients).
 */
export function albumQueryParts(
  libraryId: string,
  userId: string,
  rawQuery: Record<string, unknown>,
  /** Facet dimension to ignore, so a dimension's own counts stay browsable while it is filtered. */
  omit?: 'state' | 'genre' | 'decade' | 'format' | 'label' | 'gap',
) {
  const q = (omit ? { ...rawQuery, [omit]: undefined, ...(omit === 'state' ? { filter: undefined } : {}) } : rawQuery) as Record<string, unknown>;
  /** Fastify gives a string for one value and an array for a repeated parameter. */
  const arr = (v: unknown): string[] =>
    v === undefined || v === null || v === '' ? [] : (Array.isArray(v) ? v : [v]).map(String).filter((s) => s !== '');
  const inList = (values: string[]) => sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
  const anyOf = (parts: ReturnType<typeof sql>[]) => sql`(${sql.join(parts, sql` or `)})`;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);

  const conds = [eq(localAlbums.libraryId, libraryId)];
  const search = str(q['q']) ?? str(q['search']);
  const artist = str(q['artist']);
  if (artist) conds.push(eq(localAlbums.artistGuess, artist));
  if (search) {
    // Column references stay qualified: the facet queries join tables that
    // carry the same names (gaps.state, releases.date, …).
    conds.push(sql`(${localAlbums.titleGuess} ilike ${'%' + search + '%'} or ${localAlbums.artistGuess} ilike ${'%' + search + '%'})`);
  }
  const states = arr(q['state'] ?? q['filter']).filter((s) => s !== 'all');
  if (states.length) conds.push(sql`${localAlbums.state} in ${inList(states)}`);
  const decidedClause = str(q['decided']) ? DECIDED_CLAUSES[str(q['decided'])!] : undefined;
  if (decidedClause) conds.push(decidedExists(decidedClause));

  const ownReviewWhere = sql`ur.library_id = ${localAlbums.libraryId} and ur.release_group_id = ${localAlbums.releaseGroupId} and ur.user_id = ${userId}`;
  const listensWhere = sql`l.library_id = ${localAlbums.libraryId} and l.release_group_id = ${localAlbums.releaseGroupId} and l.user_id = ${userId}`;
  const ownRatingSql = sql`(select ur.rating from user_reviews ur where ${ownReviewWhere} limit 1)`;
  const lastListenSql = sql`(select max(l.listened_at) from listens l where ${listensWhere})`;
  const REVIEW_CLAUSES: Record<string, ReturnType<typeof sql>> = {
    reviewed: sql`exists (select 1 from user_reviews ur where ${ownReviewWhere} and coalesce(ur.body_md, '') <> '')`,
    unreviewed: sql`not exists (select 1 from user_reviews ur where ${ownReviewWhere} and coalesce(ur.body_md, '') <> '')`,
    rated: sql`exists (select 1 from user_reviews ur where ${ownReviewWhere} and ur.rating is not null)`,
    listened: sql`exists (select 1 from listens l where ${listensWhere})`,
  };
  const reviewClause = str(q['review']) ? REVIEW_CLAUSES[str(q['review'])!] : undefined;
  if (reviewClause) conds.push(reviewClause);

  const genres = arr(q['genre']);
  if (genres.length) {
    // `in (a, b)` (not `= a or = b`) lets the planner probe idx_entity_tags_entity_id
    // once per album; a null release id simply matches nothing.
    conds.push(sql`exists (select 1 from entity_tags et where et.tag in ${inList(genres)} and et.kind in ('genre', 'style')
      and et.entity_id in (${localAlbums.releaseGroupId}, ${localAlbums.releaseId}))`);
  }
  const decades = arr(q['decade']).map((d) => parseInt(d, 10)).filter(Number.isFinite);
  if (decades.length) {
    conds.push(anyOf(decades.map((d) => sql`(${localAlbums.yearGuess} >= ${d} and ${localAlbums.yearGuess} < ${d + 10})`)));
  }
  const formats = arr(q['format']);
  if (formats.length) {
    const formatClause = (f: string) =>
      f === 'lossless' ? sql`(exists (${LOSSLESS_TRACKS(localAlbums.id)}) and not exists (${LOSSY_TRACKS(localAlbums.id)}))`
        : f === 'lossy' ? sql`(not exists (${LOSSLESS_TRACKS(localAlbums.id)}))`
          : f === 'mixed' ? sql`(exists (${LOSSLESS_TRACKS(localAlbums.id)}) and exists (${LOSSY_TRACKS(localAlbums.id)}))`
            : sql`(${f} = any(${localAlbums.formats}))`;
    conds.push(anyOf(formats.map(formatClause)));
  }
  const labelNames = arr(q['label']);
  if (labelNames.length) {
    conds.push(sql`exists (select 1 from releases r where r.id = ${localAlbums.releaseId} and ${anyOf(
      labelNames.map((l) => sql`r.labels @> ${JSON.stringify([{ name: l }])}::jsonb`),
    )})`);
  }
  const ownedSql = sql`exists (select 1 from collection_items ci where ci.release_group_id = ${localAlbums.releaseGroupId} and ci.removed_at is null)`;
  const owned = str(q['owned']);
  if (owned === 'both') conds.push(ownedSql);
  else if (owned === 'digital') conds.push(sql`not ${ownedSql}`);
  // Same `in` shape for idx_gaps_subject: the `or` form was a 15k-row scan per
  // album (27 s per count on prod, 2026-09-08).
  const openGap = (kindClause: ReturnType<typeof sql>) => sql`exists (select 1 from gaps g where g.state = 'open' ${kindClause}
    and g.subject_id in (${localAlbums.id}, ${localAlbums.releaseGroupId}))`;
  const gapKinds = arr(q['gap']);
  if (gapKinds.length) {
    conds.push(anyOf(gapKinds.map((g) => (g === 'none' ? sql`(not ${openGap(sql``)})` : openGap(sql`and g.kind = ${g}`)))));
  }

  const orderings: Record<string, ReturnType<typeof sql>> = {
    artist: sql`lower(coalesce(artist_guess, '')), year_guess nulls last, lower(coalesce(title_guess, ''))`,
    title: sql`lower(coalesce(title_guess, '')), lower(coalesce(artist_guess, ''))`,
    year: sql`year_guess desc nulls last, lower(coalesce(artist_guess, ''))`,
    added_date: sql`created_at desc`,
    rating: sql`${ownRatingSql} desc nulls last, lower(coalesce(artist_guess, ''))`,
    listened: sql`${lastListenSql} desc nulls last, lower(coalesce(artist_guess, ''))`,
  };
  return { conds, orderings, REVIEW_CLAUSES, ownedSql, openGap };
}

/**
 * Facet responses are cached per (library, user, query) for a few seconds:
 * the rail refetches on every toggle and the ten count statements cost ~1 s
 * cold even with the indexes. Short enough that identify decisions landing in
 * the worker show up on the next click; handlers that change many albums at
 * once (bulk actions) call bustFacetCache() so the grid's immediate refetch
 * is fresh.
 */
const FACET_CACHE_TTL_MS = 15_000;
const FACET_CACHE_MAX = 200;
const facetCache = new Map<string, { at: number; libraryId: string; body: unknown }>();

export function bustFacetCache(libraryId?: string): void {
  for (const [key, entry] of facetCache) {
    if (!libraryId || entry.libraryId === libraryId) facetCache.delete(key);
  }
}

function facetCacheKey(libraryId: string, userId: string, rawQuery: Record<string, unknown>): string {
  const pairs = Object.keys(rawQuery).sort().map((k) => [k, rawQuery[k]]);
  return `${libraryId}|${userId}|${JSON.stringify(pairs)}`;
}

function storeFacetCache(cacheKey: string, libraryId: string, body: unknown): void {
  if (facetCache.size >= FACET_CACHE_MAX) {
    const oldest = facetCache.keys().next().value;
    if (oldest !== undefined) facetCache.delete(oldest);
  }
  facetCache.set(cacheKey, { at: Date.now(), libraryId, body });
}

export async function createAlbumRoutes(fastify: FastifyInstance) {
  /**
   * Facet counts for the filter rail (spec BRW-1): each dimension counted
   * over the albums matching the current query, so the rail narrows down.
   */
  fastify.get('/libraries/:libraryId/albums/facets', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const db = getDb();
    const lib = await db.select({ id: libraries.id }).from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

    const rawQuery = request.query as Record<string, unknown>;
    const userId = request.user.id;
    const cacheKey = facetCacheKey(libraryId, userId, rawQuery);
    const hit = facetCache.get(cacheKey);
    if (hit && Date.now() - hit.at < FACET_CACHE_TTL_MS) {
      reply.header('x-liner-cache', 'hit');
      return reply.send(hit.body);
    }
    // XO-363: the worker-maintained album_facets table answers every request
    // whose filters it covers, unless a bulk action marked it stale.
    if (summaryEligible(rawQuery) && (await summaryFresh(db, libraryId))) {
      const body = await summaryFacets(db, libraryId, userId, rawQuery);
      storeFacetCache(cacheKey, libraryId, body);
      reply.header('x-liner-cache', 'miss');
      reply.header('x-liner-facets', 'summary');
      return reply.send(body);
    }
    reply.header('x-liner-facets', 'live');
    const { conds, REVIEW_CLAUSES, ownedSql, openGap } = albumQueryParts(libraryId, userId, rawQuery);
    const where = and(...conds)!;
    // A dimension's own filter is dropped from its own counts, so a checked
    // box still shows what its siblings would add (standard faceted search).
    const whereWithout = (omit: Parameters<typeof albumQueryParts>[3]) =>
      and(...albumQueryParts(libraryId, userId, rawQuery, omit).conds)!;
    const [wState, wFormat, wDecade, wGenre, wLabel, wGap] = (['state', 'format', 'decade', 'genre', 'label', 'gap'] as const).map(whereWithout);
    type Row = Record<string, string | number | null>;
    const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Row[];
    const facet = (list: Row[], key: string, label?: (v: string) => string) =>
      list.filter((r) => r[key] != null).map((r) => ({
        value: String(r[key]), ...(label ? { label: label(String(r[key])) } : {}), count: Number(r['n']),
      }));

    // The ten statements are independent; run them together (pool of
    // connections) instead of one after another.
    const [[totals], states, formats, containers, decades, genres, labels, gapRows, [gapNone]] = await Promise.all([
      rows(sql`
        select count(*)::int as total,
               count(*) filter (where ${ownedSql})::int as owned_both,
               count(*) filter (where ${REVIEW_CLAUSES['reviewed']})::int as reviewed,
               count(*) filter (where ${REVIEW_CLAUSES['rated']})::int as rated,
               count(*) filter (where ${REVIEW_CLAUSES['listened']})::int as listened,
               count(*) filter (where not ${openGap(sql``)})::int as no_gap,
               ${sql.join(Object.entries(DECIDED_CLAUSES).map(([k, c]) => sql`count(*) filter (where ${decidedExists(c)})::int as ${sql.raw(`decided_${k}`)}`), sql`, `)}
        from local_albums where ${where}`),
      rows(sql`select state, count(*)::int as n from local_albums where ${wState} group by state order by n desc`),
      // One pass over the album's files instead of three correlated EXISTS per
      // album (2.3 s → 0.8 s on prod). Left joins keep track-less albums as
      // 'lossy', as before; a null lossless flag counts as neither.
      rows(sql`
        select k, count(*)::int as n from (
          select local_albums.id,
                 case when bool_or(af.lossless is true) and not bool_or(af.lossless is false) then 'lossless'
                      when bool_or(af.lossless is true) then 'mixed'
                      else 'lossy' end as k
          from local_albums
          left join local_tracks lt on lt.local_album_id = local_albums.id
          left join audio_files af on af.id = lt.audio_file_id
          where ${wFormat} group by local_albums.id) x group by k order by n desc`),
      rows(sql`select f, count(*)::int as n from local_albums, unnest(formats) f where ${wFormat} group by f order by n desc limit 12`),
      // tag garbage produces years like 1000 or 1720; the rail only offers plausible decades
      rows(sql`select (year_guess / 10) * 10 as decade, count(*)::int as n from local_albums where ${wDecade} and year_guess between 1900 and 2100 group by 1 order by 1`),
      rows(sql`
        select et.tag, count(distinct local_albums.id)::int as n from local_albums
        join entity_tags et on et.kind in ('genre', 'style') and et.entity_id in (local_albums.release_group_id, local_albums.release_id)
        where ${wGenre} group by et.tag order by n desc, et.tag limit 60`),
      rows(sql`
        select l->>'name' as name, count(*)::int as n from local_albums
        join releases r on r.id = local_albums.release_id
        cross join lateral jsonb_array_elements(coalesce(r.labels, '[]'::jsonb)) l
        where ${wLabel} and l->>'name' is not null group by 1 order by n desc, 1 limit 60`),
      rows(sql`
        select g.kind, count(distinct local_albums.id)::int as n from local_albums
        join gaps g on g.state = 'open' and g.subject_id in (local_albums.id, local_albums.release_group_id)
        where ${wGap} group by g.kind order by n desc`),
      rows(sql`select count(*)::int as n from local_albums where ${wGap} and not ${openGap(sql``)}`),
    ]);
    const total = Number(totals?.['total'] ?? 0);

    const n = (k: string) => Number(totals?.[k] ?? 0);
    const body = {
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
      decided: Object.keys(DECIDED_CLAUSES).map((k) => ({ value: k, count: n(`decided_${k}`) })),
    };
    storeFacetCache(cacheKey, libraryId, body);
    reply.header('x-liner-cache', 'miss');
    reply.send(body);
  });

  // Get albums for a library with pagination and filters
  fastify.get('/libraries/:libraryId/albums', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const { limit = '50', offset = '0', sort = 'artist' } = request.query as Record<string, string>;
    const userId = request.user.id;

    const db = getDb();

    // Verify library ownership
    const lib = await db
      .select()
      .from(libraries)
      .where(
        and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
      );

    if (lib.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const { conds, orderings } = albumQueryParts(libraryId, userId, request.query as Record<string, string>);
    const albums = await db
      .select()
      .from(localAlbums)
      .where(and(...conds))
      .orderBy(orderings[sort] ?? orderings['artist']!)
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    const limitN = parseInt(limit, 10);
    const offsetN = parseInt(offset, 10);
    // Shared contract (spec §13): cursor envelope { items, nextCursor }.
    // Cursor is the next offset until true keyset pagination lands.
    reply.status(200).send({
      items: await (async () => {
        const artRows = albums.length
          ? await db
              .select({ localAlbumId: images.localAlbumId })
              .from(images)
              .where(and(eq(images.kind, 'front'), inArray(images.localAlbumId, albums.map((a) => a.id))))
          : [];
        const withArt = new Set(artRows.map((r) => r.localAlbumId));
        // canonical track counts + open attention gaps for n/N badges (XO-311)
        const relIds = [...new Set(albums.map((a) => a.releaseId).filter((x): x is string => !!x))];
        const relRows = relIds.length
          ? await db.select({ id: releases.id, trackCount: releases.trackCount }).from(releases).where(inArray(releases.id, relIds))
          : [];
        const canonCount = new Map(relRows.map((r) => [r.id, r.trackCount]));
        const subjectIds = [...new Set(albums.flatMap((a) => [a.id, a.releaseGroupId]).filter((x): x is string => !!x))];
        const gapRows = subjectIds.length
          ? await db
              .select({ subjectId: gaps.subjectId })
              .from(gaps)
              .where(and(
                eq(gaps.state, 'open'),
                inArray(gaps.kind, ['incomplete_album', 'duplicate']),
                inArray(gaps.subjectId, subjectIds),
              ))
          : [];
        const flagged = new Set(gapRows.map((g) => g.subjectId));
        const matchRows = albums.length
          ? ((await db.execute(sql`
              select distinct on (local_album_id) local_album_id, decided_by, reason
              from album_matches
              where local_album_id in ${sql`(${sql.join(albums.map((a) => sql`${a.id}`), sql`, `)})`}
                and status in ('auto', 'confirmed')
              order by local_album_id, decided_at desc nulls last`)) as unknown as {
              local_album_id: string; decided_by: string; reason: string | null;
            }[])
          : [];
        const kindOf = (r: { decided_by: string; reason: string | null }): string => {
          const reason = r.reason ?? '';
          if (reason.startsWith('manual MBID')) return 'manual_mbid';
          if (reason.startsWith('chip-rule')) return 'chip_rule';
          if (reason.startsWith('first-candidate')) return 'first_candidate';
          if (r.decided_by === 'user') return 'by_me';
          return 'auto_strong';
        };
        const matchKind = new Map(matchRows.map((r) => [r.local_album_id, kindOf(r)]));
        // own rating / reviewed / last listen for badges and sorts (REV-3)
        const rgIds = [...new Set(albums.map((a) => a.releaseGroupId).filter((x): x is string => !!x))];
        const reviewRows = rgIds.length
          ? await db
              .select({ releaseGroupId: userReviews.releaseGroupId, rating: userReviews.rating, bodyMd: userReviews.bodyMd })
              .from(userReviews)
              .where(and(eq(userReviews.libraryId, libraryId), eq(userReviews.userId, userId), inArray(userReviews.releaseGroupId, rgIds)))
          : [];
        const ownReview = new Map(reviewRows.map((r) => [r.releaseGroupId, r]));
        const listenRows = rgIds.length
          ? ((await db.execute(sql`
              select release_group_id, max(listened_at) as last_listened_at
              from listens
              where library_id = ${libraryId} and user_id = ${userId}
                and release_group_id in ${sql`(${sql.join(rgIds.map((id) => sql`${id}`), sql`, `)})`}
              group by release_group_id`)) as unknown as { release_group_id: string; last_listened_at: Date | string }[])
          : [];
        const lastListened = new Map(listenRows.map((r) => [r.release_group_id, new Date(r.last_listened_at).toISOString()]));
        // lossless / lossy / mixed badge per album from the files themselves (m4a can be either)
        const losslessRows = albums.length
          ? ((await db.execute(sql`
              select lt.local_album_id, bool_and(coalesce(af.lossless, false)) as all_lossless, bool_or(coalesce(af.lossless, false)) as any_lossless
              from local_tracks lt join audio_files af on af.id = lt.audio_file_id
              where lt.local_album_id in ${sql`(${sql.join(albums.map((a) => sql`${a.id}`), sql`, `)})`}
              group by lt.local_album_id`)) as unknown as { local_album_id: string; all_lossless: boolean; any_lossless: boolean }[])
          : [];
        const losslessOf = new Map(losslessRows.map((r) => [r.local_album_id, r]));
        return albums.map((album) => ({
        id: album.id,
        libraryId: album.libraryId,
        localAlbumId: album.id,
        title: album.titleGuess ?? 'Unknown Album',
        artistCredit: album.artistGuess ?? 'Unknown Artist',
        ...(album.yearGuess ? { year: album.yearGuess } : {}),
        formats: album.formats ?? [],
        isLossless: losslessOf.get(album.id)?.all_lossless ?? false,
        isMixed: (losslessOf.get(album.id)?.any_lossless ?? false) && !(losslessOf.get(album.id)?.all_lossless ?? false),
        state: album.state,
        trackCount: album.trackCount ?? 0,
        canonicalTrackCount: (album.releaseId && canonCount.get(album.releaseId)) || null,
        needsAttention: flagged.has(album.id) || (!!album.releaseGroupId && flagged.has(album.releaseGroupId)),
        matchKind: matchKind.get(album.id) ?? null,
        totalDurationMs: album.totalDurationMs ?? 0,
        coverUrl: withArt.has(album.id) ? `/api/v1/images/album/${album.id}` : null,
        hasReview: !!(album.releaseGroupId && (ownReview.get(album.releaseGroupId)?.bodyMd ?? '').trim()),
        ownRating: album.releaseGroupId && ownReview.get(album.releaseGroupId)?.rating != null
          ? Number(ownReview.get(album.releaseGroupId)!.rating) : null,
        lastListenedAt: (album.releaseGroupId && lastListened.get(album.releaseGroupId)) || null,
        ...(album.releaseId ? { releaseId: album.releaseId } : {}),
        ...(album.releaseGroupId ? { releaseGroupId: album.releaseGroupId } : {}),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        }));
      })(),
      nextCursor: albums.length === limitN ? String(offsetN + limitN) : null,
    });
  });

  // Get single album details
  fastify.get(
    '/libraries/:libraryId/albums/:albumId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(
          and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
        );

      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      // Get album
      const albums = await db
        .select()
        .from(localAlbums)
        .where(
          and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId))
        );

      if (albums.length === 0) {
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      const album = albums[0];
      if (!album) {
        // Invariant: this should never happen since we checked albums.length > 0 above
        throw new ApiError(404, 'Not Found', 'Album not found');
      }

      const trackRows = await db
        .select({
          id: localTracks.id,
          discNo: localTracks.discNo,
          trackNo: localTracks.trackNo,
          title: localTracks.titleGuess,
          artist: localTracks.artistGuess,
          durationMs: localTracks.durationMs,
          origin: localTracks.origin,
          cueStartMs: localTracks.cueStartMs,
          cueRelPath: localTracks.cueRelPath,
          fileId: audioFiles.id,
          relPath: audioFiles.relPath,
          container: audioFiles.container,
          codec: audioFiles.codec,
          lossless: audioFiles.lossless,
          bitrateKbps: audioFiles.bitrateKbps,
          sampleRate: audioFiles.sampleRate,
          bitDepth: audioFiles.bitDepth,
          sizeBytes: audioFiles.sizeBytes,
          fileStatus: audioFiles.status,
          hasEmbeddedArt: audioFiles.hasEmbeddedArt,
        })
        .from(localTracks)
        .innerJoin(audioFiles, eq(audioFiles.id, localTracks.audioFileId))
        .where(eq(localTracks.localAlbumId, albumId));

      let release: Record<string, unknown> | null = null;
      let canonicalTrackRows: Record<string, unknown>[] = [];
      if (album.releaseId) {
        const relRows = await db
          .select()
          .from(releases)
          .where(eq(releases.id, album.releaseId))
          .limit(1);
        const rel = relRows[0];
        if (rel) {
          const rgRows = await db
            .select()
            .from(releaseGroups)
            .where(eq(releaseGroups.id, rel.releaseGroupId))
            .limit(1);

          // Collect external links from release.mbid, rg.mbid, discogs ids, and external_ids
          const externalLinks: Array<{ title: string; url: string; source: string }> = [];

          // Add MusicBrainz release link
          if (rel.mbid) {
            externalLinks.push({
              title: 'MusicBrainz Release',
              url: `https://musicbrainz.org/release/${rel.mbid}`,
              source: 'musicbrainz',
            });
          }

          // Add MusicBrainz release group link
          if (rgRows[0]?.mbid) {
            externalLinks.push({
              title: 'MusicBrainz Release Group',
              url: `https://musicbrainz.org/release-group/${rgRows[0].mbid}`,
              source: 'musicbrainz',
            });
          }

          // Add Discogs release link
          if (rel.discogsReleaseId) {
            externalLinks.push({
              title: 'Discogs Release',
              url: `https://www.discogs.com/release/${rel.discogsReleaseId}`,
              source: 'discogs',
            });
          }

          // Add Discogs master link
          if (rgRows[0]?.discogsmasterId) {
            externalLinks.push({
              title: 'Discogs Master',
              url: `https://www.discogs.com/master/${rgRows[0].discogsmasterId}`,
              source: 'discogs',
            });
          }

          // Add external_ids rows with provider in ('wikidata', 'wikipedia')
          const extIdRows = await db
            .select()
            .from(externalIds)
            .where(
              and(
                inArray(externalIds.provider, ['wikidata', 'wikipedia']),
                eq(externalIds.entityType, 'release'),
                eq(externalIds.entityId, rel.id)
              )
            );
          extIdRows.forEach((row) => {
            if (row.url) {
              externalLinks.push({
                title: row.provider === 'wikidata' ? 'Wikidata' : 'Wikipedia',
                url: row.url,
                source: row.provider,
              });
            }
          });

          // Also check for release_group external_ids
          if (rgRows[0]) {
            const rgExtIdRows = await db
              .select()
              .from(externalIds)
              .where(
                and(
                  inArray(externalIds.provider, ['wikidata', 'wikipedia']),
                  eq(externalIds.entityType, 'release_group'),
                  eq(externalIds.entityId, rgRows[0].id)
                )
              );
            rgExtIdRows.forEach((row) => {
              if (row.url) {
                externalLinks.push({
                  title: row.provider === 'wikidata' ? 'Wikidata' : 'Wikipedia',
                  url: row.url,
                  source: row.provider,
                });
              }
            });
          }

          const tagRows = await db
            .select({ tag: entityTags.tag, kind: entityTags.kind, entityId: entityTags.entityId })
            .from(entityTags)
            .where(and(
              inArray(entityTags.entityId, rgRows[0] ? [rel.id, rgRows[0].id] : [rel.id]),
              inArray(entityTags.kind, ['genre', 'style']),
            ));
          const uniq = (kind: string) => [...new Set(tagRows.filter((t) => t.kind === kind).map((t) => t.tag))];
          release = {
            id: rel.id,
            mbid: rel.mbid ?? null,
            genres: uniq('genre'),
            styles: uniq('style'),
            title: rel.title,
            date: rel.date,
            country: rel.country,
            status: rel.status,
            barcode: rel.barcode,
            labels: rel.labels,
            trackCount: rel.trackCount,
            artistCredit: rgRows[0]?.artistCredit ?? null,
            releaseGroupMbid: rgRows[0]?.mbid ?? null,
            discogsReleaseId: rel.discogsReleaseId ?? null,
            discogsMasterId: rgRows[0]?.discogsmasterId ?? null,
            sourceOfTruth: rel.sourceOfTruth,
            externalLinks,
            fetchedAt: rel.fetchedAt?.toISOString() ?? null,
          };
          canonicalTrackRows = (await db
            .select()
            .from(canonicalTracks)
            .where(eq(canonicalTracks.releaseId, rel.id))) as unknown as Record<string, unknown>[];
        }
      }

      const matchRows = await db
        .select()
        .from(albumMatches)
        .where(eq(albumMatches.localAlbumId, albumId));
      const liveMatch = matchRows.find((m) => m.status === 'auto' || m.status === 'confirmed');

      // Get editions if matched and release group has an mbid
      let editions = null;
      if (album.releaseGroupId && liveMatch) {
        const rgRow = await db
          .select()
          .from(releaseGroups)
          .where(eq(releaseGroups.id, album.releaseGroupId))
          .limit(1);
        if (rgRow[0]?.mbid) {
          const editionRows = await db
            .select({
              id: releases.id,
              mbid: releases.mbid,
              title: releases.title,
              status: releases.status,
              date: releases.date,
              country: releases.country,
              barcode: releases.barcode,
              packaging: releases.packaging,
              labels: releases.labels,
              media: releases.media,
              trackCount: releases.trackCount,
              discogsReleaseId: releases.discogsReleaseId,
            })
            .from(releases)
            .where(eq(releases.releaseGroupId, album.releaseGroupId))
            .orderBy(releases.date);

          // Count other local_albums with each release (spec ENR-1)
          const otherAlbumCounts = new Map<string, number>();
          if (editionRows.length > 0) {
            const countRows = await db.execute(sql`
              select release_id, count(*)::int as cnt from local_albums
              where release_id in ${sql`(${sql.join(editionRows.map((e) => sql`${e.id}`), sql`, `)})`}
                and library_id = ${libraryId}
                and id != ${albumId}
              group by release_id
            `) as unknown as Array<{ release_id: string; cnt: number }>;
            countRows.forEach((row) => otherAlbumCounts.set(row.release_id, row.cnt));
          }

          editions = {
            fetchedAt: rgRow[0].editionsFetchedAt?.toISOString() ?? null,
            releaseGroupMbid: rgRow[0].mbid,
            editions: editionRows.map((e) => ({
              releaseId: e.id,
              mbid: e.mbid,
              title: e.title,
              ...(e.status ? { status: e.status } : {}),
              ...(e.date ? { date: e.date } : {}),
              ...(e.country ? { country: e.country } : {}),
              ...(e.barcode ? { barcode: e.barcode } : {}),
              ...(e.packaging ? { packaging: e.packaging } : {}),
              labels: e.labels || [],
              media: e.media || [],
              trackCount: e.trackCount ?? 0,
              owned: e.id === album.releaseId,
              ownedByOtherAlbums: otherAlbumCounts.get(e.id) ?? 0,
              discogsReleaseId: e.discogsReleaseId ?? undefined,
            })),
          };
        }
      }

      const art = await db
        .select({ id: images.id, origin: images.origin, license: images.licenseNote })
        .from(images)
        .where(and(eq(images.localAlbumId, albumId), eq(images.kind, 'front')))
        .limit(1);

      // Everything the album page needs to act without leaving (XO-311):
      // open/dismissed gaps, scored candidates, sibling copies of the same RG.
      const gapSubjects = album.releaseGroupId ? [albumId, album.releaseGroupId] : [albumId];
      const gapRows = await db
        .select()
        .from(gaps)
        .where(and(inArray(gaps.subjectId, gapSubjects), inArray(gaps.state, ['open', 'dismissed'])));

      const candRows = await db
        .select({
          id: matchCandidates.id,
          distance: matchCandidates.distance,
          breakdown: matchCandidates.breakdown,
          source: matchCandidates.source,
          excluded: matchCandidates.excluded,
          releaseId: releases.id,
          releaseMbid: releases.mbid,
          discogsReleaseId: releases.discogsReleaseId,
          releaseTitle: releases.title,
          releaseDate: releases.date,
          releaseCountry: releases.country,
          releaseStatus: releases.status,
          releaseTrackCount: releases.trackCount,
          releaseLabels: releases.labels,
          releaseMedia: releases.media,
          sourceOfTruth: releases.sourceOfTruth,
          rgArtistCredit: releaseGroups.artistCredit,
          rgMbid: releaseGroups.mbid,
        })
        .from(matchCandidates)
        .innerJoin(releases, eq(releases.id, matchCandidates.releaseId))
        .innerJoin(releaseGroups, eq(releaseGroups.id, releases.releaseGroupId))
        .where(eq(matchCandidates.localAlbumId, albumId))
        .orderBy(sql`distance asc`);

      const duplicateRows = album.releaseGroupId
        ? await db
            .select({
              id: localAlbums.id,
              title: localAlbums.titleGuess,
              artist: localAlbums.artistGuess,
              trackCount: localAlbums.trackCount,
              formats: localAlbums.formats,
              state: localAlbums.state,
              dirPaths: localAlbums.dirPaths,
            })
            .from(localAlbums)
            .where(and(
              eq(localAlbums.releaseGroupId, album.releaseGroupId),
              sql`${localAlbums.id} != ${albumId}`,
            ))
        : [];

      // GAP-3: physical copies of this release group from the synced Discogs
      // collection (user data — stays inside this library).
      const physicalRows = album.releaseGroupId
        ? await db.execute(sql`
            select id, folder_name, media_condition, sleeve_condition, rating, push_state, push_error
            from collection_items
            where library_id = ${libraryId} and release_group_id = ${album.releaseGroupId} and removed_at is null
            order by date_added desc nulls last`) as unknown as Array<Record<string, unknown>>
        : [];
      const discogsCollectionItems = physicalRows.map((r) => ({
        id: String(r['id']),
        folder: String(r['folder_name'] ?? 'All'),
        ...(r['media_condition'] ? { mediaCondition: String(r['media_condition']) } : {}),
        ...(r['sleeve_condition'] ? { sleeveCondition: String(r['sleeve_condition']) } : {}),
        ...(typeof r['rating'] === 'number' && r['rating'] > 0 ? { rating: r['rating'] } : {}),
        ...(r['push_state'] ? { pushState: String(r['push_state']) } : {}),
        ...(r['push_error'] ? { pushError: String(r['push_error']) } : {}),
      }));

      const missingTracks = canonicalTrackRows
        .filter((c) => !c['isDataTrack'] && !c['isVideo'])
        .filter((c) => !trackRows.some(
          (t) => (t.discNo ?? 1) === ((c['mediumNo'] as number | null) ?? 1) && t.trackNo === c['position'],
        ))
        .map((c) => ({
          disc: c['mediumNo'] ?? 1,
          position: c['position'],
          title: c['title'],
          lengthMs: c['lengthMs'] ?? null,
        }));

      const isCueImage = trackRows.some((t) => t.origin === 'cue');
      const cueRelPath = trackRows.find((t) => t.origin === 'cue')?.cueRelPath ?? null;

      // Fetch artists and genres for the album (XO-310)
      let artists: Array<{ id: string | null; name: string; position: number }> = [];
      let genres: { effective: string[]; styles: string[]; raw: Array<{ tag: string; kind: string; source: string; weight: number | null }> } = {
        effective: [],
        styles: [],
        raw: [],
      };

      if (album.releaseGroupId) {
        // Fetch artists from release_group_artists
        const artistRows = await db
          .select()
          .from(releaseGroupArtists)
          .where(eq(releaseGroupArtists.releaseGroupId, album.releaseGroupId))
          .orderBy(releaseGroupArtists.position);

        artists = artistRows.map((row) => ({
          id: row.artistId,
          name: row.creditedName ?? '',
          position: row.position,
        }));

        // Fetch genre map from library settings
        const rgTagRows = await db
          .select()
          .from(entityTags)
          .where(
            and(
              eq(entityTags.entityType, 'release_group'),
              eq(entityTags.entityId, album.releaseGroupId)
            )
          );

        let rawTags = rgTagRows.map((row) => ({
          tag: row.tag,
          kind: row.kind as 'genre' | 'style' | 'tag',
          source: row.source,
          weight: row.weight ? Number(row.weight) : null,
        }));

        const libSettings2 = lib[0];
        const settings2 = typeof libSettings2?.settings === 'string'
          ? JSON.parse(libSettings2.settings)
          : (libSettings2?.settings ?? {});
        const genreMapRaw2 = (settings2 as Record<string, any>)['genreMap'] ?? null;
        const map2 = normalizeGenreMap(genreMapRaw2);

        const effective = effectiveGenres(rawTags, map2);
        genres = {
          effective: effective.genres,
          styles: effective.styles,
          raw: rawTags,
        };
      }

      const pendingIdentify = await pendingIdentifyJob(album.id);

      reply.status(200).send({
        id: album.id,
        libraryId: album.libraryId,
        releaseGroupId: album.releaseGroupId ?? null,
        title: album.titleGuess,
        artistCredit: album.artistGuess,
        year: album.yearGuess,
        state: album.state,
        pendingIdentify,
        dirPaths: album.dirPaths,
        formats: album.formats,
        discCount: album.discCount,
        trackCount: album.trackCount,
        totalDurationMs: album.totalDurationMs,
        coverUrl: art[0] ? `/api/v1/images/album/${album.id}` : null,
        coverOrigin: art[0]?.origin ?? null,
        isCueImage,
        cueRelPath,
        release,
        match: liveMatch
          ? {
              status: liveMatch.status,
              decidedBy: liveMatch.decidedBy,
              distance: Number(liveMatch.distance),
              decidedAt: liveMatch.decidedAt?.toISOString() ?? null,
              reason: liveMatch.reason,
              releaseGroupOnly: liveMatch.releaseGroupOnly,
            }
          : null,
        editions,
        tracks: trackRows
          .sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
          .map((t) => {
            const canon = canonicalTrackRows.find(
              (c) => (c['mediumNo'] ?? 1) === (t.discNo ?? 1) && c['position'] === t.trackNo,
            );
            return {
              id: t.id,
              discNo: t.discNo,
              trackNo: t.trackNo,
              title: t.title,
              artist: t.artist,
              durationMs: t.durationMs,
              origin: t.origin,
              cueStartMs: t.cueStartMs,
              canonicalTitle: (canon?.['title'] as string) ?? null,
              canonicalDurationMs: (canon?.['lengthMs'] as number) ?? null,
              file: {
                id: t.fileId,
                relPath: t.relPath,
                container: t.container,
                codec: t.codec,
                lossless: t.lossless,
                bitrateKbps: t.bitrateKbps,
                sampleRate: t.sampleRate,
                bitDepth: t.bitDepth,
                sizeBytes: t.sizeBytes,
                status: t.fileStatus,
                hasEmbeddedArt: t.hasEmbeddedArt,
              },
            };
          }),
        createdAt: album.createdAt?.toISOString() || new Date().toISOString(),
        missingTracks,
        gaps: gapRows.map((g) => ({
          id: g.id,
          kind: g.kind,
          state: g.state,
          dismissReason: g.dismissReason,
          details: g.details,
        })),
        candidates: candRows.map((c) => ({
          id: c.id,
          releaseId: c.releaseId,
          releaseMbid: c.releaseMbid ?? null,
          discogsReleaseId: c.discogsReleaseId ?? null,
          title: c.releaseTitle,
          artistCredit: Array.isArray(c.rgArtistCredit)
            ? (c.rgArtistCredit as string[]).join(', ')
            : String(c.rgArtistCredit ?? ''),
          date: c.releaseDate,
          country: c.releaseCountry,
          status: c.releaseStatus,
          trackCount: c.releaseTrackCount,
          labels: c.releaseLabels,
          // media + first label tell apart two Discogs pressings that share
          // title, date, country and track count (same distance, same row)
          format: mediaSummary(c.releaseMedia),
          label: labelSummary(c.releaseLabels),
          distance: Number(c.distance),
          breakdown: c.breakdown,
          source: c.source,
          provider: c.sourceOfTruth,
          rgMbid: c.rgMbid ?? null,
          excluded: c.excluded,
        })),
        artists,
        genres,
        duplicates: duplicateRows,
        physicalOwnershipState: discogsCollectionItems.length > 0 ? 'owned' : 'not_owned',
        discogsCollectionItems,
      });
    }
  );

  // Re-fetch cover art for one album
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/fetch-art',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const boss = await getBoss();
      await boss.send('art.fetch', { localAlbumId: albumId }, { singletonKey: `art:${albumId}` });
      reply.status(202).send({ ok: true });
    }
  );

  // IDN-6 manual entry: paste an MB release URL / MBID or Discogs URL / ID, match it outright.
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/match-mbid',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const { input } = (request.body ?? {}) as { input?: string };

      // Try MBID first
      const mbid = input?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (mbid) {
        // Check for non-release MB URLs
        if (input && /musicbrainz\.org\/(?!release\/)[a-z-]+\//i.test(input)) {
          throw new ApiError(400, 'Bad Request', 'That is not a release URL — use the release page (musicbrainz.org/release/...), not artist or release-group');
        }
        const db = getDb();
        const lib = await db
          .select()
          .from(libraries)
          .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
        if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
        const pendingMb = await pendingIdentifyJob(albumId);
        if (pendingMb) {
          reply.status(409).send({ status: 409, title: 'Conflict', detail: 'An identification request is already queued for this album — cancel it before submitting another.', pending: pendingMb });
          return;
        }
        const boss = await getBoss();
        const jobId = await boss.send('identify.album', { localAlbumId: albumId, force: true, pinnedMbid: mbid }, {
          singletonKey: IDENTIFY_SINGLETON(albumId),
          priority: IDENTIFY_PRIORITY.manual,
        });
        reply.status(202).send({ ok: true, mbid, jobId, pending: await pendingIdentifyJob(albumId) });
        return;
      }

      // Try Discogs
      const discogsRef = parseDiscogsRef(input || '');
      if (discogsRef) {
        const db = getDb();
        const lib = await db
          .select()
          .from(libraries)
          .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
        if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
        const pendingDg = await pendingIdentifyJob(albumId);
        if (pendingDg) {
          reply.status(409).send({ status: 409, title: 'Conflict', detail: 'An identification request is already queued for this album — cancel it before submitting another.', pending: pendingDg });
          return;
        }
        const boss = await getBoss();
        const jobId = await boss.send('identify.album', { localAlbumId: albumId, force: true, pinnedDiscogs: discogsRef }, {
          singletonKey: IDENTIFY_SINGLETON(albumId),
          priority: IDENTIFY_PRIORITY.manual,
        });
        reply.status(202).send({ ok: true, discogs: discogsRef, jobId, pending: await pendingIdentifyJob(albumId) });
        return;
      }

      // Neither worked
      throw new ApiError(400, 'Bad Request', 'No MusicBrainz MBID or Discogs URL / ID found in input — paste a MusicBrainz release URL / MBID or a Discogs release / master URL / ID');
    }
  );

  // Re-run identification for one album (spec IDN-6)
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/identify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const pending = await pendingIdentifyJob(albumId);
      if (pending) {
        reply.status(409).send({ status: 409, title: 'Conflict', detail: 'An identification request is already queued for this album — cancel it before submitting another.', pending });
        return;
      }
      const boss = await getBoss();
      const jobId = await boss.send('identify.album', { localAlbumId: albumId, force: true }, {
        singletonKey: IDENTIFY_SINGLETON(albumId),
        priority: IDENTIFY_PRIORITY.manual,
      });
      reply.status(202).send({ ok: true, jobId, pending: await pendingIdentifyJob(albumId) });
    }
  );

  // Cancel the queued identification request for an album (manual pin,
  // re-identify or the sweep's own job). An active job cannot be interrupted;
  // it is marked cancelled and finishes on the worker.
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/identify-request/cancel',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const pending = await pendingIdentifyJob(albumId);
      if (!pending) throw new ApiError(404, 'Not Found', 'No identification request is queued for this album');
      await cancelIdentifyJob(await getBoss(), pending.id);
      reply.send({ cancelled: pending.id, wasActive: pending.state === 'active' });
    }
  );

  // BRW-2: Get editions for an album (on-demand fetch with polling)
  fastify.get(
    '/libraries/:libraryId/albums/:albumId/editions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();

      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');
      const album = albums[0]!;

      if (!album.releaseGroupId) {
        // Unmatched albums simply have no editions yet (the page asks for every album).
        return reply.status(200).send({ fetchedAt: null, releaseGroupMbid: null, editions: [] });
      }

      const rgRows = await db
        .select()
        .from(releaseGroups)
        .where(eq(releaseGroups.id, album.releaseGroupId))
        .limit(1);
      if (!rgRows[0]) throw new ApiError(404, 'Not Found', 'Release group not found');
      const rg = rgRows[0]!;

      if (!rg.mbid) {
        throw new ApiError(400, 'Bad Request', 'Release group has no MusicBrainz ID');
      }

      // If editions not recently fetched, enqueue fetch (client polls while null)
      if (!rg.editionsFetchedAt || new Date().getTime() - rg.editionsFetchedAt.getTime() > 30 * 24 * 3600 * 1000) {
        const boss = await getBoss();
        await boss.send('editions.fetch', { releaseGroupId: album.releaseGroupId }, { singletonKey: `editions:${rg.id}` });
      }

      const editionRows = await db
        .select({
          id: releases.id,
          mbid: releases.mbid,
          title: releases.title,
          status: releases.status,
          date: releases.date,
          country: releases.country,
          barcode: releases.barcode,
          packaging: releases.packaging,
          labels: releases.labels,
          media: releases.media,
          trackCount: releases.trackCount,
        })
        .from(releases)
        .where(eq(releases.releaseGroupId, album.releaseGroupId))
        .orderBy(releases.date);

      // Count other local_albums with each release
      const otherAlbumCounts = new Map<string, number>();
      if (editionRows.length > 0) {
        const countRows = await db.execute(sql`
          select release_id, count(*)::int as cnt from local_albums
          where release_id in ${sql`(${sql.join(editionRows.map((e) => sql`${e.id}`), sql`, `)})`}
            and library_id = ${libraryId}
            and id != ${albumId}
          group by release_id
        `) as unknown as Array<{ release_id: string; cnt: number }>;
        countRows.forEach((row) => otherAlbumCounts.set(row.release_id, row.cnt));
      }

      reply.status(200).send({
        fetchedAt: rg.editionsFetchedAt?.toISOString() ?? null,
        releaseGroupMbid: rg.mbid,
        editions: editionRows.map((e) => ({
          releaseId: e.id,
          mbid: e.mbid,
          title: e.title,
          ...(e.status ? { status: e.status } : {}),
          ...(e.date ? { date: e.date } : {}),
          ...(e.country ? { country: e.country } : {}),
          ...(e.barcode ? { barcode: e.barcode } : {}),
          ...(e.packaging ? { packaging: e.packaging } : {}),
          labels: e.labels || [],
          media: e.media || [],
          trackCount: e.trackCount ?? 0,
          owned: e.id === album.releaseId,
          ownedByOtherAlbums: otherAlbumCounts.get(e.id) ?? 0,
        })),
      });
    }
  );

  // BRW-2: Refresh editions (force re-fetch)
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/editions/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();

      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');
      const album = albums[0]!;

      if (!album.releaseGroupId) {
        throw new ApiError(400, 'Bad Request', 'Album has no matched release group');
      }

      const boss = await getBoss();
      await boss.send(
        'editions.fetch',
        { releaseGroupId: album.releaseGroupId, force: true },
        { singletonKey: `editions:${album.releaseGroupId}` }
      );
      reply.status(202).send({ ok: true });
    }
  );

  // IDN-3: Match at release-group level (owner chooses "any edition")
  fastify.post(
    '/libraries/:libraryId/albums/:albumId/match-any-edition',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();

      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      const matches = await db
        .select()
        .from(albumMatches)
        .where(
          and(
            eq(albumMatches.localAlbumId, albumId),
            sql`status in ('auto', 'confirmed')`
          )
        )
        .limit(1);
      if (matches.length === 0) throw new ApiError(404, 'Not Found', 'No live match');

      const match = matches[0]!;
      await db
        .update(albumMatches)
        .set({
          releaseGroupOnly: true,
          reason: (match.reason ? `${match.reason}; ` : '') + 'any edition (owner)',
          decidedBy: 'user',
        })
        .where(eq(albumMatches.id, match.id));

      reply.status(200).send({ ok: true });
    }
  );

  // IDN-3: Clear "any edition" flag
  fastify.delete(
    '/libraries/:libraryId/albums/:albumId/match-any-edition',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const db = getDb();

      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      const matches = await db
        .select()
        .from(albumMatches)
        .where(
          and(
            eq(albumMatches.localAlbumId, albumId),
            sql`status in ('auto', 'confirmed')`
          )
        )
        .limit(1);
      if (matches.length === 0) throw new ApiError(404, 'Not Found', 'No live match');

      const match = matches[0]!;
      const newReason = match.reason
        ? match.reason.replace(/;\s*any edition \(owner\)$/, '')
        : null;
      await db
        .update(albumMatches)
        .set({
          releaseGroupOnly: false,
          reason: newReason,
        })
        .where(eq(albumMatches.id, match.id));

      reply.status(200).send({ ok: true });
    }
  );

  // Create field lock for an album
  fastify.patch(
    '/libraries/:libraryId/albums/:albumId/fields',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
      const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
      const { field, value, reason } = request.body as { field: string; value: unknown; reason?: string };

      if (!field) throw new ApiError(400, 'Bad Request', 'field is required');

      const db = getDb();

      // Verify library ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      // Verify album belongs to the specified library
      const albums = await db
        .select()
        .from(localAlbums)
        .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)))
        .limit(1);
      if (albums.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

      // Create the field lock
      const result = await db
        .insert(fieldLocks)
        .values({
          libraryId,
          scope: 'album',
          scopeId: albumId,
          field,
          value,
          reason: reason ?? null,
          createdBy: request.user.id,
        })
        .returning({
          id: fieldLocks.id,
          field: fieldLocks.field,
          value: fieldLocks.value,
          createdAt: fieldLocks.createdAt,
          createdBy: fieldLocks.createdBy,
        });

      if (result.length === 0) throw new ApiError(500, 'Internal Server Error', 'Failed to create field lock');

      // Write to audit log
      const lock = result[0]!;
      await db.insert(auditLog).values({
        libraryId,
        actorUserId: request.user.id,
        action: 'lock.create',
        subjectType: 'field',
        subjectId: lock.id,
        payload: {
          album_id: albumId,
          field,
          value,
        },
      });

      reply.status(201).send(lock);
    }
  );

  // Search albums
  fastify.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { q, type = 'album', limit = '20' } = request.query as Record<string, string>;

    if (!q) {
      throw new ApiError(400, 'Bad Request', 'Search query required');
    }

    const db = getDb();

    // Get user's libraries
    const userLibraries = await db
      .select()
      .from(libraries)
      .where(eq(libraries.ownerUserId, request.user.id));

    const libraryIds = userLibraries.map((l) => l.id);

    // Search albums across libraries
    const results: any[] = [];

    if (type === 'album' || type === 'all') {
      const albums = await db
        .select()
        .from(localAlbums)
        .limit(parseInt(limit, 10));

      const filtered = albums.filter(
        (a) =>
          libraryIds.includes(a.libraryId) &&
          (a.titleGuess?.toLowerCase().includes(q.toLowerCase()) ||
            a.artistGuess?.toLowerCase().includes(q.toLowerCase()))
      );

      results.push(
        ...filtered.map((a) => ({
          type: 'album',
          id: a.id,
          title: a.titleGuess,
          artist: a.artistGuess,
          libraryId: a.libraryId,
        }))
      );
    }

    reply.status(200).send({ results: results.slice(0, parseInt(limit, 10)) });
  });
}

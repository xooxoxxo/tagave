/**
 * Similar artists, the similar-artists module.
 *
 *   GET  /api/v1/libraries/:libraryId/artists/:artistId/similar   catalog.read: the artist page's section
 *   GET  /api/v1/libraries/:libraryId/artists/:artistId/mix       catalog.read: up to 100 of the artist's tracks, shuffled (the section's Play)
 *   POST /api/v1/libraries/:libraryId/similar-artists/follow      library.edit: { mbid, name } follow an artist the library has no row for
 *   GET  /api/v1/settings/similar-artists                         system.manage: Settings › Modules › Similar artists
 *   PUT  /api/v1/settings/similar-artists                         system.manage + fresh step-up: { enabled }
 *   POST /api/v1/settings/similar-artists/remove-data             system.manage + fresh step-up: turn it off, delete its rows
 *
 * The section: the artists in this library first (their tagave page, the
 * card picture), then the others (MusicBrainz's comment, Follow, Listen
 * elsewhere links when that module is on). Opening an artist queues
 * similarArtists.fetch when its list is missing or a week old; `pending`
 * says the first one is on its way. Off: { available: false }, nothing is
 * queued.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  listenLinksEnabled, listenPrefsOf, listenPrimaryOf, removeSimilarArtistsData, setSimilarArtistsEnabled, similarArtistsEnabled, albumLiveSql, trackLiveSql,
} from '@tagave/db';
import { composeListenLinks } from '@tagave/core/listen-links';
import { similarDue, similarNameKey } from '@tagave/core/similar-artists';
import {
  LISTEN_PLATFORMS, SIMILAR_ELSEWHERE_MAX, SIMILAR_IN_LIBRARY_MAX, SIMILAR_SHOWN, displayArtistName, similarArtistsModuleSchema, similarFollowSchema,
  type ArtistSimilarView, type ListenPlatform, type SimilarArtistsModuleView, type SimilarElsewhereView, type SimilarInLibraryView,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import { getDb } from '../db.js';
import { coversFor, type ArtistRow } from '../lib/artistList.js';
import { followDefaultsFor } from '../lib/followRules.js';
import { installLastfmApp } from '../lib/scrobbling.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIX_TRACKS = 100;

type Sql = ReturnType<typeof getAuthHandle>['sql'];

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

async function library(sql: Sql, libraryId: string): Promise<{ settings: unknown }> {
  if (!UUID_RE.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const [row] = await sql<Array<{ settings: unknown }>>`select settings from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
  return row;
}

const EMPTY = (available: boolean): ArtistSimilarView => ({ available, pending: false, inLibrary: [], elsewhere: [], primary: null });

/** Queue one artist's fetch, or say it is on its way. Never fails the page. */
async function queue(request: FastifyRequest, artistId: string): Promise<boolean> {
  try {
    const boss = await getBoss();
    await boss.send('similarArtists.fetch', { artistId }, { singletonKey: `similar:${artistId}`, retryLimit: 1 });
    return true;
  } catch (err) {
    request.log.warn({ err, artistId }, 'similarArtists.fetch not queued');
    return false;
  }
}

async function moduleView(sql: Sql): Promise<SimilarArtistsModuleView> {
  const [c] = await sql<Array<{ artists: number; similar: number }>>`
    select (select count(*)::int from similar_artist_checks where found > 0) as artists,
           (select count(*)::int from similar_artists) as similar`;
  return { enabled: await similarArtistsEnabled(sql), artists: c!.artists, similar: c!.similar, lastfm: (await installLastfmApp(sql)) !== null };
}

export async function createSimilarArtistsRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/artists/:artistId/similar', async (request): Promise<ArtistSimilarView> => {
    const me = user(request);
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    if (!UUID_RE.test(artistId)) throw new ApiError(404, 'Not Found', 'Artist not found');
    const [artist] = await sql<Array<{ mbid: string | null }>>`select mbid::text as mbid from artists where id = ${artistId}`;
    if (!artist) throw new ApiError(404, 'Not Found', 'Artist not found');
    if (!(await similarArtistsEnabled(sql))) return EMPTY(false);
    if (!artist.mbid) return EMPTY(true);

    const [check] = await sql<Array<{ fetched_at: Date; error: string | null }>>`select fetched_at, error from similar_artist_checks where artist_id = ${artistId}`;
    let pending = false;
    if (similarDue(check ? { fetchedAt: check.fetched_at, error: check.error } : null)) {
      const queued = await queue(request, artistId);
      pending = queued && !check;
    }

    const rows = await sql<Array<{ mbid: string | null; name: string; comment: string | null }>>`
      select similar_mbid::text as mbid, name, comment from similar_artists where artist_id = ${artistId} order by position`;
    if (rows.length === 0) return { ...EMPTY(true), pending };

    // tagave's rows for them: by MBID, else by name
    const mbids = rows.flatMap((r) => (r.mbid ? [r.mbid] : []));
    const byMbid = new Map((await sql<Array<{ id: string; mbid: string; name: string }>>`
      select id::text as id, mbid::text as mbid, name from artists where mbid = any(${mbids}::text[]) and id <> ${artistId}`).map((a) => [a.mbid, a]));
    const unmatched = rows.filter((r) => !r.mbid || !byMbid.has(r.mbid)).map((r) => r.name.toLowerCase());
    const byName = new Map<string, { id: string; name: string }>();
    if (unmatched.length) {
      for (const a of await sql<Array<{ id: string; name: string; mbid: string | null }>>`
        select id::text as id, name, mbid::text as mbid from artists where lower(name) = any(${unmatched}::text[]) and id <> ${artistId}`) {
        const key = similarNameKey(a.name);
        if (!byName.has(key)) byName.set(key, a);
      }
    }
    const matched = rows.map((r) => {
      const hit = (r.mbid ? byMbid.get(r.mbid) : undefined) ?? (!r.mbid || !byMbid.has(r.mbid) ? byName.get(similarNameKey(r.name)) : undefined);
      // a name match must not be another artist with its own MBID
      const sameOne = hit && (!r.mbid || !('mbid' in hit) || !hit.mbid || hit.mbid === r.mbid) ? hit : undefined;
      return { ...r, artistId: sameOne?.id ?? null };
    });
    const ids = [...new Set(matched.flatMap((m) => (m.artistId ? [m.artistId] : [])))];

    const owned = new Map((await sql<Array<{ id: string; n: number }>>`
      select rga.artist_id::text as id, count(distinct la.id)::int as n
        from release_group_artists rga
        join local_albums la on la.release_group_id = rga.release_group_id and la.library_id = ${libraryId}
       where rga.artist_id = any(${ids}::uuid[]) and ${sql.unsafe(albumLiveSql('la.id'))}
       group by rga.artist_id`).map((r) => [r.id, r.n]));
    const followed = new Set((await sql<Array<{ id: string }>>`
      select artist_id::text as id from followed_artists where library_id = ${libraryId} and artist_id = any(${ids}::uuid[])`).map((r) => r.id));

    const seen = new Set<string>();
    const inLib = matched.filter((m) => m.artistId && (owned.get(m.artistId) ?? 0) > 0 && !seen.has(m.artistId) && seen.add(m.artistId)).slice(0, SIMILAR_IN_LIBRARY_MAX);
    const room = Math.min(SIMILAR_ELSEWHERE_MAX, SIMILAR_SHOWN - inLib.length);
    const rest = matched.filter((m) => !(m.artistId && (owned.get(m.artistId) ?? 0) > 0)).slice(0, room);

    const covers = inLib.length
      ? await coversFor(getDb() as never, libraryId, inLib.map((m) => ({ id: m.artistId, name: m.name }) as ArtistRow))
      : new Map<string, string[]>();
    const inLibrary: SimilarInLibraryView[] = inLib.map((m) => ({
      artistId: m.artistId!,
      name: displayArtistName(m.name) ?? m.name,
      coverAlbumIds: covers.get(m.artistId!) ?? [],
      albums: owned.get(m.artistId!) ?? 0,
    }));

    // Listen elsewhere: the artist's page when tagave knows it, else a search (built here, never stored)
    let primary: ListenPlatform | null = null;
    let platforms: ListenPlatform[] = [];
    if (rest.length && (await listenLinksEnabled(sql))) {
      platforms = (await listenPrefsOf(sql, me.id)).filter((p): p is ListenPlatform => (LISTEN_PLATFORMS as readonly string[]).includes(p));
      const p = await listenPrimaryOf(sql, me.id);
      primary = p && (platforms as string[]).includes(p) ? (p as ListenPlatform) : null;
    }
    const restIds = rest.flatMap((m) => (m.artistId ? [m.artistId] : []));
    const pages = new Map<string, Map<string, string>>();
    if (platforms.length && restIds.length) {
      for (const r of await sql<Array<{ id: string; platform: string; url: string }>>`
        select artist_id::text as id, platform, url from listen_artist_links where artist_id = any(${restIds}::uuid[])`) {
        pages.set(r.id, (pages.get(r.id) ?? new Map()).set(r.platform, r.url));
      }
    }
    const elsewhere: SimilarElsewhereView[] = rest.map((m) => ({
      mbid: m.mbid,
      name: m.name,
      comment: m.comment,
      artistId: m.artistId,
      followed: !!m.artistId && followed.has(m.artistId),
      listen: platforms.length
        ? composeListenLinks({ platforms, album: new Map(), artist: (m.artistId && pages.get(m.artistId)) || new Map(), query: m.name })
        : [],
    }));
    return { available: true, pending, inLibrary, elsewhere, primary };
  });

  fastify.get('/libraries/:libraryId/artists/:artistId/mix', async (request): Promise<{ name: string; trackIds: string[] }> => {
    user(request);
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    const { sql } = getAuthHandle();
    await library(sql, libraryId);
    if (!UUID_RE.test(artistId)) throw new ApiError(404, 'Not Found', 'Artist not found');
    const [a] = await sql<Array<{ name: string }>>`select name from artists where id = ${artistId}`;
    if (!a) throw new ApiError(404, 'Not Found', 'Artist not found');
    const rows = await sql<Array<{ id: string }>>`
      select lt.id::text as id
        from local_tracks lt
        join local_albums la on la.id = lt.local_album_id and la.library_id = ${libraryId}
       where exists (select 1 from release_group_artists rga where rga.release_group_id = la.release_group_id and rga.artist_id = ${artistId})
         and ${sql.unsafe(trackLiveSql('lt.audio_file_id'))}
       order by random()
       limit ${MIX_TRACKS}`;
    return { name: displayArtistName(a.name) ?? a.name, trackIds: rows.map((r) => r.id) };
  });

  fastify.post('/libraries/:libraryId/similar-artists/follow', async (request): Promise<{ artistId: string; followed: true }> => {
    user(request);
    sameSite(request);
    const { libraryId } = request.params as { libraryId: string };
    const parsed = similarFollowSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'mbid (a MusicBrainz id) and name are required');
    const { sql } = getAuthHandle();
    const lib = await library(sql, libraryId);
    if (!(await similarArtistsEnabled(sql))) throw new ApiError(409, 'Conflict', 'Similar artists is turned off.');
    const { mbid, name } = parsed.data;
    // tagave's row for the artist: the one it has, else a new one by MBID (artists.enrich fills in the rest)
    const [row] = await sql<Array<{ id: string }>>`
      insert into artists (mbid, name) values (${mbid}, ${name})
      on conflict (mbid) do update set mbid = excluded.mbid
      returning id::text as id`;
    const artistId = row!.id;
    const defaults = followDefaultsFor(lib.settings as never);
    // followed_artists has no unique key: one row per library and artist, as the artist page's Follow keeps it
    await sql`insert into followed_artists (library_id, artist_id, mode, include_primary, exclude_secondary)
              select ${libraryId}, ${artistId}, 'manual', ${defaults.includePrimary}::text[], ${defaults.excludeSecondary}::text[]
               where not exists (select 1 from followed_artists where library_id = ${libraryId} and artist_id = ${artistId})`;
    try {
      const boss = await getBoss();
      await boss.send('artists.enrich', { artistId }, { singletonKey: `artist:${artistId}`, retryLimit: 2, retryDelay: 30 });
      // the discography now, not at the weekly sweep: the missing albums appear on its page
      await boss.send('artist.refresh', { libraryId, artistId }, { singletonKey: `artist.refresh:${artistId}`, retryLimit: 2, retryDelay: 30 });
    } catch (err) {
      request.log.warn({ err, artistId }, 'similar artists: follow jobs not queued');
    }
    return { artistId, followed: true };
  });

  fastify.get('/settings/similar-artists', async (): Promise<SimilarArtistsModuleView> => moduleView(getAuthHandle().sql));

  fastify.put('/settings/similar-artists', async (request): Promise<SimilarArtistsModuleView> => {
    sameSite(request);
    const parsed = similarArtistsModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await setSimilarArtistsEnabled(sql, parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'similar-artists', userId: request.user?.id }, 'similar artists switched');
    return moduleView(sql);
  });

  fastify.post('/settings/similar-artists/remove-data', async (request): Promise<SimilarArtistsModuleView & { removed: Record<string, number> }> => {
    sameSite(request);
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    // off first: no fetch starts while the rows go
    await setSimilarArtistsEnabled(sql, false);
    const removed = await removeSimilarArtistsData(sql);
    await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: 'similar-artists', ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'similar-artists', userId: request.user?.id, ...removed }, 'similar artists data removed');
    return { ...(await moduleView(sql)), removed };
  });
}

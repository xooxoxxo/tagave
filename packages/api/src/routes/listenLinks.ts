/**
 * Listen elsewhere, the listen-links module (vault "tagave - External
 * Players Scoping", phase 1).
 *
 *   GET  /api/v1/libraries/:libraryId/release-groups/:rgId/listen-links   catalog.read: the caller's links for one album
 *   GET  /api/v1/libraries/:libraryId/artists/:artistId/listen-links      catalog.read: links for each album a followed artist is missing
 *   GET  /api/v1/me/listen-links                                          self: the caller's platforms
 *   PUT  /api/v1/me/listen-links                                          self: { platforms } in order
 *   GET  /api/v1/settings/listen-links                                    system.manage: the Settings › Modules row
 *   PUT  /api/v1/settings/listen-links                                    system.manage + fresh step-up: { enabled }
 *   POST /api/v1/settings/listen-links/remove-data                        system.manage + fresh step-up: turn it off, delete its rows
 *
 * Each link is the album's own page when one is known, else its artist's
 * page, else the platform's search (built here, never stored). Opening an
 * album or an artist queues listenLinks.resolve for what is not looked up
 * yet, for the platforms people picked; the answer says `pending` meanwhile.
 * Off: every link route answers { available: false } and nothing is queued.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  listenLinksEnabled, listenPrefsOf, pickedListenPlatforms, removeListenLinksData, setListenLinksEnabled, setListenPrefs,
} from '@tagave/db';
import { composeListenLinks, listenCheckDue } from '@tagave/core/listen-links';
import {
  LISTEN_PLATFORMS, displayArtistName, listenLinksModuleSchema, listenPrefsSchema,
  type AlbumListenLinksView, type ArtistListenLinksView, type ListenLinksModuleView, type ListenPlatform, type ListenPrefsView,
} from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import { requireFreshStepUp } from './stepUp.js';
import { sameSite } from './mcConnections.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function user(request: FastifyRequest): { id: string } {
  if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
  return request.user;
}

const known = (ps: readonly string[]): ListenPlatform[] => ps.filter((p): p is ListenPlatform => (LISTEN_PLATFORMS as readonly string[]).includes(p));

async function library(libraryId: string): Promise<void> {
  if (!UUID_RE.test(libraryId)) throw new ApiError(404, 'Not Found', 'Library not found');
  const { sql } = getAuthHandle();
  const [row] = await sql`select 1 from libraries where id = ${libraryId}`;
  if (!row) throw new ApiError(404, 'Not Found', 'Library not found');
}

type Check = { checked_at: Date | null; found: number | null; platforms: string[] | null };
const due = (c: Check | undefined, wanted: readonly string[]) =>
  listenCheckDue(c?.checked_at ? { checkedAt: c.checked_at, found: c.found ?? 0, platforms: c.platforms ?? [] } : null, wanted);

/** Queue a lookup (one per album or artist), or say one is on its way. Never fails the page. */
async function queue(request: FastifyRequest, data: { releaseGroupId: string } | { artistId: string }, key: string): Promise<boolean> {
  try {
    const boss = await getBoss();
    await boss.send('listenLinks.resolve', data, { singletonKey: key, retryLimit: 2 });
    return true;
  } catch (err) {
    request.log.warn({ err, key }, 'listenLinks.resolve not queued');
    return false;
  }
}

async function moduleView(): Promise<ListenLinksModuleView> {
  const { sql } = getAuthHandle();
  const [c] = await sql<Array<{ albums: number; artists: number; people: number }>>`
    select (select count(distinct release_group_id)::int from listen_links) as albums,
           (select count(distinct artist_id)::int from listen_artist_links) as artists,
           (select count(*)::int from listen_prefs where cardinality(platforms) > 0) as people`;
  return { enabled: await listenLinksEnabled(sql), albums: c!.albums, artists: c!.artists, people: c!.people };
}

export async function createListenLinksRoutes(fastify: FastifyInstance) {
  fastify.get('/libraries/:libraryId/release-groups/:rgId/listen-links', async (request): Promise<AlbumListenLinksView> => {
    const me = user(request);
    const { libraryId, rgId } = request.params as { libraryId: string; rgId: string };
    await library(libraryId);
    if (!UUID_RE.test(rgId)) throw new ApiError(404, 'Not Found', 'Release group not found');
    const { sql } = getAuthHandle();
    if (!(await listenLinksEnabled(sql))) return { available: false, links: [], pending: false };
    const [rg] = await sql<Array<{ title: string; mbid: string | null; artist_id: string | null; artist: string | null }>>`
      select rg.title, rg.mbid::text as mbid, a.id::text as artist_id, coalesce(rga.credited_name, a.name) as artist
        from release_groups rg
        left join lateral (select * from release_group_artists x where x.release_group_id = rg.id order by x.position limit 1) rga on true
        left join artists a on a.id = rga.artist_id
       where rg.id = ${rgId}`;
    if (!rg) throw new ApiError(404, 'Not Found', 'Release group not found');
    const platforms = known(await listenPrefsOf(sql, me.id));
    if (platforms.length === 0) return { available: true, links: [], pending: false };

    const album = new Map((await sql<Array<{ platform: string; url: string }>>`
      select platform, url from listen_links where release_group_id = ${rgId}`).map((r) => [r.platform, r.url]));
    const artist = rg.artist_id
      ? new Map((await sql<Array<{ platform: string; url: string }>>`select platform, url from listen_artist_links where artist_id = ${rg.artist_id}`).map((r) => [r.platform, r.url]))
      : new Map<string, string>();
    const links = composeListenLinks({ platforms, album, artist, query: [displayArtistName(rg.artist) ?? '', rg.title].filter(Boolean).join(' ') });

    let pending = false;
    if (rg.mbid) {
      const picked = await pickedListenPlatforms(sql);
      const [check] = await sql<Check[]>`select checked_at, found, platforms from listen_album_checks where release_group_id = ${rgId}`;
      const [artistCheck] = rg.artist_id ? await sql<Check[]>`select checked_at, found, platforms from listen_artist_checks where artist_id = ${rg.artist_id}` : [];
      if (due(check, picked) || (rg.artist_id && due(artistCheck, picked))) pending = await queue(request, { releaseGroupId: rgId }, `listen:rg:${rgId}`);
    }
    return { available: true, links, pending };
  });

  fastify.get('/libraries/:libraryId/artists/:artistId/listen-links', async (request): Promise<ArtistListenLinksView> => {
    const me = user(request);
    const { libraryId, artistId } = request.params as { libraryId: string; artistId: string };
    await library(libraryId);
    if (!UUID_RE.test(artistId)) throw new ApiError(404, 'Not Found', 'Artist not found');
    const { sql } = getAuthHandle();
    if (!(await listenLinksEnabled(sql))) return { available: false, albums: {}, pending: false };
    const [a] = await sql<Array<{ name: string; mbid: string | null }>>`select name, mbid::text as mbid from artists where id = ${artistId}`;
    if (!a) throw new ApiError(404, 'Not Found', 'Artist not found');
    const platforms = known(await listenPrefsOf(sql, me.id));
    if (platforms.length === 0) return { available: true, albums: {}, pending: false };

    // what the artist page lists under "Not in your library" (lib/artistAlbums.ts: open missing_album gaps)
    const missing = await sql<Array<{ id: string; title: string; checked_at: Date | null; found: number | null; platforms: string[] | null }>>`
      select rg.id::text as id, rg.title, c.checked_at, c.found, c.platforms
        from gaps g
        join release_groups rg on rg.id = g.subject_id
        left join listen_album_checks c on c.release_group_id = rg.id
       where g.library_id = ${libraryId} and g.kind = 'missing_album' and g.state = 'open'
         and exists (select 1 from release_group_artists rga where rga.release_group_id = rg.id and rga.artist_id = ${artistId})`;
    const ids = missing.map((m) => m.id);
    const exact = await sql<Array<{ rg: string; platform: string; url: string }>>`
      select release_group_id::text as rg, platform, url from listen_links where release_group_id = any(${ids}::uuid[])`;
    const byAlbum = new Map<string, Map<string, string>>();
    for (const r of exact) byAlbum.set(r.rg, (byAlbum.get(r.rg) ?? new Map()).set(r.platform, r.url));
    const artist = new Map((await sql<Array<{ platform: string; url: string }>>`select platform, url from listen_artist_links where artist_id = ${artistId}`).map((r) => [r.platform, r.url]));
    const name = displayArtistName(a.name) ?? a.name;
    const albums: Record<string, ReturnType<typeof composeListenLinks>> = {};
    for (const m of missing) albums[m.id] = composeListenLinks({ platforms, album: byAlbum.get(m.id) ?? new Map(), artist, query: `${name} ${m.title}` });

    let pending = false;
    if (missing.length > 0) {
      const picked = await pickedListenPlatforms(sql);
      const [artistCheck] = await sql<Check[]>`select checked_at, found, platforms from listen_artist_checks where artist_id = ${artistId}`;
      if ((a.mbid && due(artistCheck, picked)) || missing.some((m) => due(m, picked))) pending = await queue(request, { artistId }, `listen:artist:${artistId}`);
    }
    return { available: true, albums, pending };
  });

  fastify.get('/me/listen-links', async (request): Promise<ListenPrefsView> => {
    const me = user(request);
    const { sql } = getAuthHandle();
    return { available: await listenLinksEnabled(sql), platforms: known(await listenPrefsOf(sql, me.id)) };
  });

  fastify.put('/me/listen-links', async (request): Promise<ListenPrefsView> => {
    const me = user(request);
    sameSite(request);
    const parsed = listenPrefsSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'platforms: a list of platforms, each once');
    const { sql } = getAuthHandle();
    if (!(await listenLinksEnabled(sql))) throw new ApiError(409, 'Conflict', 'Listen elsewhere is turned off.');
    await setListenPrefs(sql, me.id, parsed.data.platforms);
    return { available: true, platforms: parsed.data.platforms };
  });

  fastify.get('/settings/listen-links', async (): Promise<ListenLinksModuleView> => moduleView());

  fastify.put('/settings/listen-links', async (request): Promise<ListenLinksModuleView> => {
    sameSite(request);
    const parsed = listenLinksModuleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', 'enabled (true or false) is required');
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    await setListenLinksEnabled(sql, parsed.data.enabled);
    request.log.info({ event: parsed.data.enabled ? 'module.enable' : 'module.disable', module: 'listen-links', userId: request.user?.id }, 'listen elsewhere switched');
    return moduleView();
  });

  fastify.post('/settings/listen-links/remove-data', async (request): Promise<ListenLinksModuleView & { removed: Record<string, number> }> => {
    sameSite(request);
    await requireFreshStepUp(request);
    const { sql } = getAuthHandle();
    // off first: no lookup starts while the rows go
    await setListenLinksEnabled(sql, false);
    const removed = await removeListenLinksData(sql);
    await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
              values (null, ${request.user?.id ?? null}, 'module.remove_data', 'module', ${JSON.stringify({ module: 'listen-links', ...removed })}::text::jsonb)`;
    request.log.info({ event: 'module.remove_data', module: 'listen-links', userId: request.user?.id, ...removed }, 'listen elsewhere data removed');
    return { ...(await moduleView()), removed };
  });
}

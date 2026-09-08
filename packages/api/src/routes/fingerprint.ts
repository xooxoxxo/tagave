/**
 * IDN-5 (XO-372): fingerprint progress for Settings › Providers and the manual
 * "Fingerprint" action on an album. The work itself runs on the workers
 * (fingerprint.album on the file worker, acoustid.lookup on the identify
 * worker); this file only reads counters and enqueues.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { libraries, localAlbums } from '@liner/db';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';

/** Manual requests jump the sweep (api/lib/identifyRequests.ts tiers: manual 100). */
const MANUAL_PRIORITY = 100;

export async function createFingerprintRoutes(fastify: FastifyInstance) {
  const ownedLibrary = async (userId: string, libraryId: string) => {
    const db = getDb();
    const lib = await db.select({ id: libraries.id, settings: libraries.settings }).from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
    return lib[0]!;
  };

  fastify.get('/libraries/:libraryId/identify/fingerprint-stats', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const lib = await ownedLibrary(request.user.id, libraryId);
    const settings = (typeof lib.settings === 'string' ? JSON.parse(lib.settings) : lib.settings ?? {}) as Record<string, unknown>;
    const db = getDb();

    const [albums] = (await db.execute(sql`
      select count(*) filter (where state = 'unidentified')::int as unidentified,
             count(*) filter (where state = 'unidentified' and fingerprinted_at is null)::int as remaining,
             count(*) filter (where fingerprinted_at is not null)::int as looked_up,
             count(*) filter (where acoustid_result = 'candidates')::int as with_candidates,
             count(*) filter (where acoustid_result = 'no_candidates')::int as no_candidates,
             count(*) filter (where acoustid_result = 'no_fingerprints')::int as no_fingerprints,
             count(*) filter (where acoustid_result = 'no_key')::int as no_key,
             count(*) filter (where acoustid_result = 'bad_key')::int as bad_key,
             count(*) filter (where state = 'matched' and exists (
               select 1 from album_matches am join match_candidates mc on mc.local_album_id = am.local_album_id and mc.release_id = am.release_id
               where am.local_album_id = local_albums.id and am.status in ('auto', 'confirmed') and mc.source = 'acoustid'))::int as matched_via_acoustid
      from local_albums where library_id = ${libraryId}`)) as unknown as [Record<string, number>];
    const [files] = (await db.execute(sql`
      select count(*) filter (where fingerprint is not null)::int as fingerprinted,
             count(*) filter (where fingerprint is null and fingerprint_error is not null)::int as failed
      from audio_files where library_id = ${libraryId}`)) as unknown as [Record<string, number>];
    const [queue] = (await db.execute(sql`
      select count(*) filter (where name = 'fingerprint.album' and state in ('created', 'active'))::int as fingerprint_waiting,
             count(*) filter (where name = 'acoustid.lookup' and state in ('created', 'active'))::int as lookup_waiting
      from pgboss.job where name in ('fingerprint.album', 'acoustid.lookup')`)) as unknown as [Record<string, number>];
    const [lookups] = (await db.execute(sql`
      select count(*)::int as cached, count(*) filter (where fetched_at > now() - interval '24 hours')::int as last_24h
      from provider_cache where provider = 'acoustid'`)) as unknown as [Record<string, number>];
    // parked circuit (bad key, quota): the sweep skips while this is in the future
    const [provider] = (await db.execute(sql`
      select circuit_open_until, last_error from provider_state
      where provider = 'acoustid' and circuit_open_until > now()`)) as unknown as [{ circuit_open_until: Date | string; last_error: string | null } | undefined];

    reply.send({
      enabled: settings['fingerprintingEnabled'] === true,
      keySet: typeof settings['acoustidKeyHint'] === 'string',
      albums: {
        unidentified: albums?.['unidentified'] ?? 0,
        remaining: albums?.['remaining'] ?? 0,
        lookedUp: albums?.['looked_up'] ?? 0,
        withCandidates: albums?.['with_candidates'] ?? 0,
        noCandidates: albums?.['no_candidates'] ?? 0,
        noFingerprints: albums?.['no_fingerprints'] ?? 0,
        noKey: albums?.['no_key'] ?? 0,
        badKey: albums?.['bad_key'] ?? 0,
        matchedViaAcoustid: albums?.['matched_via_acoustid'] ?? 0,
      },
      files: { fingerprinted: files?.['fingerprinted'] ?? 0, failed: files?.['failed'] ?? 0 },
      queue: { fingerprintWaiting: queue?.['fingerprint_waiting'] ?? 0, lookupWaiting: queue?.['lookup_waiting'] ?? 0 },
      lookups: { cached: lookups?.['cached'] ?? 0, last24h: lookups?.['last_24h'] ?? 0 },
      provider: provider
        ? { parkedUntil: new Date(provider.circuit_open_until).toISOString(), reason: provider.last_error }
        : null,
    });
  });

  fastify.post('/libraries/:libraryId/albums/:albumId/fingerprint', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId, albumId } = request.params as { libraryId: string; albumId: string };
    const lib = await ownedLibrary(request.user.id, libraryId);
    const settings = (typeof lib.settings === 'string' ? JSON.parse(lib.settings) : lib.settings ?? {}) as Record<string, unknown>;
    if (typeof settings['acoustidKeyHint'] !== 'string') {
      throw new ApiError(409, 'Conflict', 'Add an AcoustID key in Settings › Providers first');
    }
    const db = getDb();
    const album = await db.select({ id: localAlbums.id }).from(localAlbums)
      .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, libraryId)));
    if (album.length === 0) throw new ApiError(404, 'Not Found', 'Album not found');

    const boss = await getBoss();
    await boss.createQueue('fingerprint.album');
    const jobId = await boss.send('fingerprint.album', { localAlbumId: albumId, force: false }, {
      singletonKey: `fingerprint:${albumId}`, priority: MANUAL_PRIORITY,
    });
    reply.status(202).send({ ok: true, queued: jobId !== null, jobId });
  });
}

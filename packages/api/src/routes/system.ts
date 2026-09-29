import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runDoctor, remediationFor } from '@liner/doctor';
import { and, eq } from 'drizzle-orm';
import { libraries } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EXPECT_WORKERS=0 marks an install that runs no workers on purpose. Any
 * other value only says workers are expected: whether there are enough is
 * judged by the work the live workers cover (their queues), so a single
 * worker and a split install read the same everywhere.
 */
export function expectedWorkers(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * Settings › System status and the first-run wizard, once the owner account
 * exists. Same checks as `liner-doctor` (and /health), with a plain fix for
 * each one that did not pass. Owner only: the details name paths and hosts.
 * Local checks only: opening the page must not spend MusicBrainz or Discogs
 * budget.
 */
export async function createSystemRoutes(fastify: FastifyInstance) {
  fastify.get('/system/checks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    if (request.user.role !== 'owner') throw new ApiError(403, 'Forbidden', 'Only the owner can see system checks');

    // ?libraryId= scopes the music-folder check to the library on screen;
    // without it the check covers every library, as the CLI does.
    const { libraryId } = request.query as { libraryId?: string };
    if (libraryId !== undefined) {
      // A malformed id would reach Postgres as a uuid cast and come back as
      // a 500; it is a bad request.
      if (!UUID_RE.test(libraryId)) throw new ApiError(400, 'Bad Request', 'libraryId must be a UUID');
      const owned = await getDb()
        .select({ id: libraries.id })
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (owned.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const checkedAt = new Date().toISOString();
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      const check = { id: 'database', title: 'Database', status: 'fail' as const, detail: 'DATABASE_URL is not set for the app', durationMs: 0 };
      return reply.status(200).send({ ok: false, checkedAt, checks: [{ ...check, remediation: remediationFor(check) }] });
    }

    const result = await runDoctor({
      databaseUrl,
      ...(process.env.CACHE_DIR ? { cacheDir: process.env.CACHE_DIR } : {}),
      expectWorkers: expectedWorkers(process.env.EXPECT_WORKERS),
      offline: true,
      offlineDetail: 'Not tested from this page, so opening it never uses up MusicBrainz or Discogs requests. Lookups in Background activity show whether they answer.',
      // The workers read the music folders; the app host usually has none
      // mounted, so looking for them here would only add noise.
      probeHost: false,
      ...(libraryId ? { libraryId } : {}),
    });

    return reply.status(200).send({
      ok: result.ok,
      checkedAt,
      checks: result.checks.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        detail: c.detail,
        remediation: remediationFor(c),
      })),
    });
  });
}

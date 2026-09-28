import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runDoctor, remediationFor } from '@liner/doctor';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * How many live workers this install expects. Defaults to one so a
 * single-worker install reads as healthy; a split install that runs a files
 * worker and an identify worker sets EXPECT_WORKERS=2.
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

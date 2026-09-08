import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { libraries, jobRuns } from '@liner/db';
import { getDb, getSql } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/** job_runs.progress is jsonb: the driver hands it over as an object, older code paths stored a string. */
function parseProgress(value: unknown): Record<string, unknown> {
  if (value == null) return { done: 0, total: 0 };
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return { done: 0, total: 0 }; }
  }
  return value as Record<string, unknown>;
}

const subscribers = new Map<string, Set<FastifyReply>>();
let listening: Promise<void> | undefined;

/** One LISTEN connection per process (postgres.js keeps it dedicated). */
function ensureListener(fastify: FastifyInstance): Promise<void> {
  if (listening) return listening;
  listening = getSql()
    .listen('liner_jobs', (payload) => {
      let event: { type?: string; libraryId?: string } = {};
      try { event = JSON.parse(payload); } catch { return; }
      if (!event.libraryId) return;
      const subs = subscribers.get(event.libraryId);
      if (!subs) return;
      const frame = `event: ${event.type ?? 'message'}\ndata: ${payload}\n\n`;
      for (const r of subs) {
        try { r.raw.write(frame); } catch { subs.delete(r); }
      }
    })
    .then(() => undefined, (err: Error) => {
      listening = undefined;
      fastify.log.error({ err }, 'LISTEN liner_jobs failed');
    });
  return listening;
}

export async function createJobRoutes(fastify: FastifyInstance) {
  // Get all jobs for a library
  fastify.get('/libraries/:libraryId/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const { status, limit = '50', offset = '0' } = request.query as Record<string, string>;

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

    // Query job runs
    const jobs = await db
      .select()
      .from(jobRuns)
      .where(status ? and(eq(jobRuns.libraryId, libraryId), eq(jobRuns.state, status)) : eq(jobRuns.libraryId, libraryId))
      .orderBy(desc(jobRuns.createdAt))
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    const totalResult = await db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.libraryId, libraryId));

    reply.status(200).send({
      data: jobs.map((job) => ({
        id: job.id,
        type: job.type,
        state: job.state,
        progress: parseProgress(job.progress),
        startedAt: job.startedAt?.toISOString(),
        finishedAt: job.finishedAt?.toISOString(),
        error: job.error,
        createdAt: job.createdAt.toISOString(),
      })),
      pagination: {
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        total: totalResult.length,
      },
    });
  });

  // Get single job
  fastify.get(
    '/libraries/:libraryId/jobs/:jobId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, jobId } = request.params as { libraryId: string; jobId: string };

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

      // Get job
      const jobs = await db
        .select()
        .from(jobRuns)
        .where(
          and(eq(jobRuns.id, jobId), eq(jobRuns.libraryId, libraryId))
        );

      if (jobs.length === 0) {
        throw new ApiError(404, 'Not Found', 'Job not found');
      }

      const job = jobs[0];
      if (!job) {
        // Invariant: this should never happen since we checked jobs.length > 0 above
        throw new ApiError(404, 'Not Found', 'Job not found');
      }
      reply.status(200).send({
        id: job.id,
        type: job.type,
        state: job.state,
        progress: parseProgress(job.progress),
        startedAt: job.startedAt?.toISOString(),
        finishedAt: job.finishedAt?.toISOString(),
        error: job.error,
        createdAt: job.createdAt.toISOString(),
      });
    }
  );

  // Stream job events via SSE (spec §11.4): one LISTEN on `liner_jobs` per
  // process, fanned out to the clients of the library named in each event.
  // Workers publish job.progress/completed/failed (reportProgress) and
  // queue.changed (identification decisions); a heartbeat keeps proxies open.
  fastify.get(
    '/libraries/:libraryId/jobs/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId } = request.params as { libraryId: string };

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

      await ensureListener(fastify);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('data: {"type":"connected"}\n\n');

      const subs = subscribers.get(libraryId) ?? new Set<FastifyReply>();
      subs.add(reply);
      subscribers.set(libraryId, subs);
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        subs.delete(reply);
        if (subs.size === 0) subscribers.delete(libraryId);
      });
      // keep the handler open; fastify must not end the raw response
      await new Promise<void>((resolve) => request.raw.on('close', resolve));
    }
  );

  // Cancel a job
  fastify.post(
    '/libraries/:libraryId/jobs/:jobId/cancel',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, jobId } = request.params as { libraryId: string; jobId: string };

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

      // Get job
      const jobs = await db
        .select()
        .from(jobRuns)
        .where(
          and(eq(jobRuns.id, jobId), eq(jobRuns.libraryId, libraryId))
        );

      if (jobs.length === 0) {
        throw new ApiError(404, 'Not Found', 'Job not found');
      }

      const job = jobs[0];
      if (!job) {
        // Invariant: this should never happen since we checked jobs.length > 0 above
        throw new ApiError(404, 'Not Found', 'Job not found');
      }

      if (job.state === 'finished' || job.state === 'failed') {
        throw new ApiError(
          400,
          'Bad Request',
          'Cannot cancel a job that has already finished'
        );
      }

      // Update job state to cancelled
      await db.update(jobRuns).set({ state: 'cancelled' }).where(eq(jobRuns.id, jobId));

      reply.status(200).send({
        id: jobId,
        state: 'cancelled',
      });
    }
  );

  // Pause a job
  fastify.post(
    '/libraries/:libraryId/jobs/:jobId/pause',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, jobId } = request.params as { libraryId: string; jobId: string };

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

      // Get job
      const jobs = await db
        .select()
        .from(jobRuns)
        .where(
          and(eq(jobRuns.id, jobId), eq(jobRuns.libraryId, libraryId))
        );

      if (jobs.length === 0) {
        throw new ApiError(404, 'Not Found', 'Job not found');
      }

      // Update job state to paused
      await db.update(jobRuns).set({ state: 'paused' }).where(eq(jobRuns.id, jobId));

      reply.status(200).send({
        id: jobId,
        state: 'paused',
      });
    }
  );
}

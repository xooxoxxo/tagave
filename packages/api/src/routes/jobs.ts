import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { libraries, jobRuns } from '@liner/db';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

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
      .where(eq(jobRuns.libraryId, libraryId))
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
        progress: job.progress ? JSON.parse(job.progress as string) : { done: 0, total: 0 },
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
        progress: job.progress ? JSON.parse(job.progress as string) : { done: 0, total: 0 },
        startedAt: job.startedAt?.toISOString(),
        finishedAt: job.finishedAt?.toISOString(),
        error: job.error,
        createdAt: job.createdAt.toISOString(),
      });
    }
  );

  // Stream job events via SSE
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

      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');

      // Send initial message
      reply.raw.write('data: {"type":"connected"}\n\n');

      // Set up periodic polling for job updates
      const interval = setInterval(async () => {
        try {
          const jobs = await db
            .select()
            .from(jobRuns)
            .where(eq(jobRuns.libraryId, libraryId));

          jobs.forEach((job) => {
            reply.raw.write(
              `data: ${JSON.stringify({
                type: 'job_update',
                id: job.id,
                state: job.state,
                progress: job.progress ? JSON.parse(job.progress as string) : { done: 0, total: 0 },
              })}\n\n`
            );
          });
        } catch (err) {
          clearInterval(interval);
          reply.raw.end();
        }
      }, 1000);

      // Clean up on close
      request.raw.on('close', () => {
        clearInterval(interval);
      });
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

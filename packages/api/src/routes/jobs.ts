import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc, gte, notInArray } from 'drizzle-orm';
import { libraries, jobRuns, scanRoots } from '@liner/db';
import type { JobView, JobsListResponse } from '@liner/shared';
import { getDb, getSql } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { HIDDEN_JOB_TYPES, deriveJobViews, retryRequest, summarizeJobs, type JobRow } from '../lib/jobView.js';

/** How far back the activity page looks, and at most how many rows it reads. */
const WINDOW_DAYS = 30;
const WINDOW_ROWS = 1000;

type Db = ReturnType<typeof getDb>;

const rowColumns = {
  id: jobRuns.id,
  type: jobRuns.type,
  subjectType: jobRuns.subjectType,
  subjectId: jobRuns.subjectId,
  state: jobRuns.state,
  progress: jobRuns.progress,
  startedAt: jobRuns.startedAt,
  finishedAt: jobRuns.finishedAt,
  error: jobRuns.error,
  createdAt: jobRuns.createdAt,
  subjectName: scanRoots.displayName,
};

/**
 * The library's recent job_runs rows, newest first, without worker
 * heartbeats. Routine rows stay in: they tell older failures that a later
 * run went fine. `jobId` is added when it falls outside the window.
 */
export async function loadJobRows(db: Db, libraryId: string, jobId?: string): Promise<JobRow[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const rows: JobRow[] = await db
    .select(rowColumns)
    .from(jobRuns)
    .leftJoin(scanRoots, and(eq(jobRuns.subjectType, 'scan_root'), eq(scanRoots.id, jobRuns.subjectId)))
    .where(and(
      eq(jobRuns.libraryId, libraryId),
      notInArray(jobRuns.type, [...HIDDEN_JOB_TYPES]),
      gte(jobRuns.createdAt, since),
    ))
    .orderBy(desc(jobRuns.createdAt))
    .limit(WINDOW_ROWS);
  if (jobId && UUID.test(jobId) && !rows.some((r) => r.id === jobId)) {
    const extra = await db
      .select(rowColumns)
      .from(jobRuns)
      .leftJoin(scanRoots, and(eq(jobRuns.subjectType, 'scan_root'), eq(scanRoots.id, jobRuns.subjectId)))
      .where(and(eq(jobRuns.id, jobId), eq(jobRuns.libraryId, libraryId), notInArray(jobRuns.type, [...HIDDEN_JOB_TYPES])));
    // older than everything in the window, so it goes last (the rows are newest first)
    rows.push(...extra);
  }
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownLibrary(db: Db, userId: string, libraryId: string): Promise<void> {
  const lib = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, userId)));
  if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
}

/** Every visible view for the library, derived with the context of later runs. */
async function loadViews(db: Db, libraryId: string, jobId?: string): Promise<JobView[]> {
  const rows = await loadJobRows(db, libraryId, jobId);
  return deriveJobViews(rows, libraryId).filter((v): v is JobView => v !== null);
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
  // Background activity (Settings › Background activity): plain-words views
  // of the last 30 days, heartbeats never, routine checks only on request.
  //   ?include=routine  also list scheduled checks that finished normally
  //   ?job=<id>         make sure this job is in the list (deep link)
  fastify.get('/libraries/:libraryId/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(parseInt(query['limit'] ?? '50', 10) || 50, 1), 500);
    const offset = Math.max(parseInt(query['offset'] ?? '0', 10) || 0, 0);
    const includeRoutine = query['include'] === 'routine';
    const focus = query['job'];

    const db = getDb();
    await ownLibrary(db, request.user.id, libraryId);

    const views = await loadViews(db, libraryId, focus);
    const shown = includeRoutine ? views : views.filter((v) => !v.routine || v.id === focus);
    // what is happening now first, then newest activity (a long run that just
    // finished outranks a short one started after it)
    const live = (v: JobView) => (v.status === 'running' || v.status === 'waiting' ? 0 : 1);
    const ordered = [...shown].sort((a, b) => live(a) - live(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const attention = ordered.filter((v) => v.needsAttention);
    const rest = ordered.filter((v) => !v.needsAttention);
    const page = rest.slice(offset, offset + limit);
    const focused = focus ? rest.find((v) => v.id === focus) : undefined;
    if (focused && !page.includes(focused)) page.push(focused);
    const body: JobsListResponse = {
      attention,
      data: page,
      summary: summarizeJobs(views, views.length - shown.length),
      pagination: { limit, offset, total: rest.length },
    };
    reply.status(200).send(body);
  });

  // One job, in the same shape as the list.
  fastify.get(
    '/libraries/:libraryId/jobs/:jobId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, jobId } = request.params as { libraryId: string; jobId: string };
      const db = getDb();
      await ownLibrary(db, request.user.id, libraryId);

      const view = (await loadViews(db, libraryId, jobId)).find((v) => v.id === jobId);
      if (!view) throw new ApiError(404, 'Not Found', 'Job not found');
      reply.status(200).send(view);
    }
  );

  // Start a failed or interrupted job's work again. Only work that can be
  // rebuilt from the row (a folder scan, a library-wide check) is offered.
  fastify.post(
    '/libraries/:libraryId/jobs/:jobId/retry',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, jobId } = request.params as { libraryId: string; jobId: string };
      const db = getDb();
      await ownLibrary(db, request.user.id, libraryId);

      const rows = await loadJobRows(db, libraryId, jobId);
      const row = rows.find((r) => r.id === jobId);
      const view = deriveJobViews(rows, libraryId).find((v) => v?.id === jobId) ?? null;
      if (!row || !view) throw new ApiError(404, 'Not Found', 'Job not found');

      if (view.status !== 'failed' && view.status !== 'interrupted') {
        throw new ApiError(409, 'Conflict', 'This task did not fail, so there is nothing to retry.');
      }
      if (view.resolvedAt) {
        throw new ApiError(409, 'Conflict', 'A later run already finished this work.');
      }
      if (view.retrying) {
        throw new ApiError(409, 'Conflict', 'This work is already running again.');
      }
      if (!view.needsAttention) {
        throw new ApiError(409, 'Conflict', 'This work was tried again later; retry the newer attempt instead.');
      }
      const req = retryRequest(row, libraryId);
      if (!req) {
        throw new ApiError(400, 'Bad Request', 'This kind of task cannot be restarted from here.');
      }

      if (row.type === 'scan.root') {
        const [root] = await db
          .select({ validationStatus: scanRoots.validationStatus })
          .from(scanRoots)
          .where(and(eq(scanRoots.id, row.subjectId!), eq(scanRoots.libraryId, libraryId)));
        if (!root) throw new ApiError(409, 'Conflict', 'This music folder has been removed.');
        if (root.validationStatus !== 'ok') {
          throw new ApiError(409, 'Conflict', 'tagave cannot read this music folder right now. Check it under Settings › Music folders.');
        }
      }

      const boss = await getBoss();
      await boss.createQueue(req.queue);
      const pgbossId = await boss.send(req.queue, req.data, { singletonKey: req.singletonKey });

      // Show the retry as waiting until the worker writes its own row.
      let newJobId: string | null = null;
      if (pgbossId) {
        const [inserted] = await db.insert(jobRuns).values({
          libraryId,
          type: row.type,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          state: 'created',
          progress: { done: 0, total: 0 },
          pgbossId,
        }).returning({ id: jobRuns.id });
        newJobId = inserted?.id ?? null;
      }

      reply.status(202).send({ queued: pgbossId !== null, jobId: newJobId });
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

      if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
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

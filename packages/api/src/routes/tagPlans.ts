import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { and, eq, inArray, count, desc, sql } from 'drizzle-orm';
import {
  tagPlans,
  tagPlanItems,
  audioFiles,
  localAlbums,
  localTracks,
  libraries,
  scanRoots,
  artists,
} from '@liner/db';
import {
  type CreateTagPlan,
  createTagPlanSchema,
  tagPlanScopeSchema,
  type TagPlan,
  type TagPlanItem,
  type TagPlanPreviewJob,
  type TagPlanScope,
  type TagPolicies,
} from '@liner/shared';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { albumQueryParts } from './albums.js';
import { filesOfAlbums, resolveEditableScope, suggestBulkValues } from '../lib/bulkTagEdit.js';

/**
 * Register tag plan routes.
 * Per Spec §13 and TAG-2/TAG-3: Tag plans API endpoints
 * - GET /api/v1/libraries/:libraryId/tag-plans (list with pagination)
 * - POST /api/v1/libraries/:libraryId/tag-plans (create new plan)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId (fetch)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId/items (filtered items)
 * - POST /api/v1/libraries/:libraryId/tag-plans/:planId/preview (enqueue preview job)
 */
/** Raw rows read timestamps (and sometimes jsonb) as strings on the shared client; accept both. */
const isoOf = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string | Date).toISOString());

/**
 * The newest tags.preview job for a plan: pg-boss says whether it is queued,
 * running or done; the worker's job_runs row (matched by pg-boss id) says
 * what it is doing and how many files it has compared.
 */
export async function latestPreviewJob(db: ReturnType<typeof getDb>, planId: string): Promise<TagPlanPreviewJob | undefined> {
  const rows = (await db.execute(sql`
    select j.id::text as job_id, j.state as boss_state, j.created_on, j.started_on, j.completed_on,
           r.id::text as run_id, r.progress, r.error
      from pgboss.job j
      left join job_runs r on r.pgboss_id = j.id::text and r.type = 'tags.preview'
     where j.name = 'tags.preview' and j.data->>'planId' = ${planId}
     order by j.created_on desc, r.created_at desc nulls last
     limit 1`)) as unknown as Array<{
    job_id: string; boss_state: string; created_on: unknown; started_on: unknown; completed_on: unknown;
    run_id: string | null; progress: unknown; error: string | null;
  }>;
  const row = rows[0];
  if (!row) return undefined;
  const state: TagPlanPreviewJob['state'] =
    row.boss_state === 'completed' ? 'completed'
    : row.boss_state === 'failed' || row.boss_state === 'cancelled' ? 'failed'
    : row.boss_state === 'active' ? 'running'
    : 'queued'; // created, retry
  const raw = typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress;
  const progress = (raw ?? {}) as { done?: unknown; total?: unknown; message?: unknown };
  const startedAt = isoOf(row.started_on);
  const finishedAt = isoOf(row.completed_on);
  return {
    jobId: row.job_id,
    state,
    queuedAt: isoOf(row.created_on)!,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(row.run_id ? { jobRunId: row.run_id } : {}),
    ...(typeof progress.message === 'string' && progress.message ? { message: progress.message } : {}),
    ...(typeof progress.done === 'number' ? { done: progress.done } : {}),
    ...(typeof progress.total === 'number' && progress.total > 0 ? { total: progress.total } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/**
 * Readable scope per plan: artist name for artist scopes (one query for the
 * page), album counts otherwise. The raw scope keeps the ids.
 */
async function scopeLabels(db: ReturnType<typeof getDb>, scopes: TagPlanScope[]): Promise<string[]> {
  const artistIds = Array.from(new Set(scopes.flatMap((s) => (s.type === 'artist' ? [s.artistId] : []))));
  const names = new Map<string, string>();
  if (artistIds.length > 0) {
    const rows = await db.select({ id: artists.id, name: artists.name }).from(artists).where(inArray(artists.id, artistIds));
    for (const r of rows) names.set(r.id, r.name);
  }
  return scopes.map((s) => {
    switch (s.type) {
      case 'library': return 'Entire library';
      case 'artist': return names.get(s.artistId) ?? 'One artist';
      case 'albumIds': return s.albumIds.length === 1 ? '1 album' : `${s.albumIds.length} albums`;
      case 'filterQuery': return 'Filtered albums';
      case 'folder': return `Folder ${s.dirPath}`;
      default: return 'Unknown scope';
    }
  });
}

/** Plans that can still change: nothing has been written to disk yet. */
const OPEN_PLAN_STATUSES: string[] = ['draft', 'previewed'];
const PLAN_CLOSED = 'This plan has already been applied or is being applied. Start a new plan instead.';

const addItemsSchema = z.object({
  scope: z.object({
    type: z.literal('albumIds'),
    albumIds: z.array(z.string().uuid()).min(1).max(5000),
  }),
});

export async function createTagPlansRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/libraries/:libraryId/tag-plans
   * List tag plans with pagination
   */
  fastify.get<{ Params: { libraryId: string }; Querystring: { limit?: string; offset?: string; acceptsAlbums?: string } }>(
    '/tag-plans',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId } = request.params as { libraryId: string };
      const limit = Math.min(Math.max(parseInt((request.query as any).limit || '50', 10), 1), 200);
      const offset = Math.max(parseInt((request.query as any).offset || '0', 10), 0);
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

      // ?acceptsAlbums=true: only plans albums can still be added to (not yet
      // applied, scoped to a list of albums), for the album page's "Fix tags".
      const acceptsAlbums = (request.query as any).acceptsAlbums === 'true';
      const where = acceptsAlbums
        ? and(
            eq(tagPlans.libraryId, libraryId),
            inArray(tagPlans.status, OPEN_PLAN_STATUSES),
            sql`${tagPlans.scope}->>'type' = 'albumIds'`,
          )
        : eq(tagPlans.libraryId, libraryId);

      // Get total count
      const countResult = await db
        .select({ count: count() })
        .from(tagPlans)
        .where(where);

      const total = countResult[0]?.count ?? 0;

      // Get paginated plans, ordered by created_at desc
      const plans = await db
        .select()
        .from(tagPlans)
        .where(where)
        .orderBy(desc(tagPlans.createdAt))
        .limit(limit)
        .offset(offset);

      const scopes = plans.map((p) => (typeof p.scope === 'string' ? JSON.parse(p.scope) : p.scope) as TagPlanScope);
      const labels = await scopeLabels(db, scopes);

      const formatted: TagPlan[] = plans.map((p, i) => {
        const scopeData = scopes[i]!;
        const policyData = typeof p.policy === 'string' ? JSON.parse(p.policy) : p.policy;
        const statsData = typeof p.stats === 'string' ? JSON.parse(p.stats) : p.stats;
        return {
          id: p.id,
          libraryId: p.libraryId,
          name: p.name,
          scope: scopeData as TagPlanScope,
          scopeLabel: labels[i],
          policy: policyData as TagPolicies,
          status: p.status as any,
          stats: statsData ?? { filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] },
          createdBy: p.createdBy,
          createdAt: p.createdAt.toISOString(),
          appliedAt: p.appliedAt?.toISOString(),
        };
      });

      reply.send({ items: formatted, limit, offset, total });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans
   * Create a new tag plan
   */
  fastify.post<{ Params: { libraryId: string }; Body: CreateTagPlan }>(
    '/tag-plans',
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

      const parsed = createTagPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid plan');
      }
      const body = parsed.data;

      // A manual plan writes the values the owner typed; without any there is
      // nothing to write, and the values mean nothing under another preset.
      if (body.policy.preset === 'manual') {
        const values = body.policy.values ?? {};
        if (Object.keys(values).length === 0) {
          throw new ApiError(400, 'Bad Request', 'Set at least one value to write (album artist, album, date, compilation, genre or track artist)');
        }
      } else if (body.policy.values) {
        throw new ApiError(400, 'Bad Request', 'Typed values only apply to the manual preset');
      }

      // A filter or folder scope is resolved to the matching album ids now —
      // the worker has no query builder — so the plan records what the scope
      // meant today.
      let scope: TagPlanScope = body.scope;
      if (scope.type === 'filterQuery') {
        const { conds } = albumQueryParts(libraryId, request.user.id, scope.filterQuery as Record<string, unknown>);
        const rows = await db.select({ id: localAlbums.id }).from(localAlbums).where(and(...conds));
        if (rows.length === 0) throw new ApiError(400, 'Bad Request', 'The filter matches no albums');
        scope = { type: 'albumIds', albumIds: rows.map((r) => r.id) };
      } else if (scope.type === 'folder') {
        const ids = await resolveEditableScope(db, libraryId, scope);
        if (ids.length === 0) throw new ApiError(400, 'Bad Request', `No album has files in ${scope.dirPath}`);
        scope = { type: 'albumIds', albumIds: ids };
      } else if (scope.type === 'albumIds') {
        // The preview trusts the plan's album ids; they must be this library's.
        const requested = [...new Set(scope.albumIds)];
        const known = await db.select({ id: localAlbums.id }).from(localAlbums)
          .where(and(eq(localAlbums.libraryId, libraryId), inArray(localAlbums.id, requested)));
        if (known.length !== requested.length) throw new ApiError(400, 'Bad Request', 'Some of these albums are not in this library.');
        scope = { type: 'albumIds', albumIds: requested };
      }

      const planId = uuidv7();
      const now = new Date();

      await db.insert(tagPlans).values({
        id: planId,
        libraryId,
        name: body.name,
        scope,
        policy: body.policy,
        status: 'draft',
        stats: {},
        createdBy: request.user.id,
        createdAt: now,
      });

      const plans = await db
        .select()
        .from(tagPlans)
        .where(eq(tagPlans.id, planId));

      if (plans.length === 0) {
        throw new ApiError(500, 'Internal Server Error', 'Plan creation failed');
      }

      const plan = plans[0]!;
      const scopeData = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;
      const policyData = typeof plan.policy === 'string' ? JSON.parse(plan.policy) : plan.policy;
      const statsData = typeof plan.stats === 'string' ? JSON.parse(plan.stats) : plan.stats;

      const formatted: TagPlan = {
        id: plan.id,
        libraryId: plan.libraryId,
        name: plan.name,
        scope: scopeData as TagPlanScope,
        policy: policyData as TagPolicies,
        status: plan.status as any,
        stats: statsData ?? { filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] },
        createdBy: plan.createdBy,
        createdAt: plan.createdAt.toISOString(),
        appliedAt: plan.appliedAt?.toISOString(),
      };

      reply.status(201).send(formatted);
    }
  );

  /**
   * GET /api/v1/libraries/:libraryId/tag-plans/:planId
   * Fetch a specific tag plan
   */
  fastify.get<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;
      const scopeData = typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope;
      const policyData = typeof plan.policy === 'string' ? JSON.parse(plan.policy) : plan.policy;
      const statsData = typeof plan.stats === 'string' ? JSON.parse(plan.stats) : plan.stats;

      // Item counts by status: the plan page draws apply progress from these
      // (no job id needed after a reload).
      const counts = await db
        .select({ status: tagPlanItems.status, n: sql<number>`count(*)::int` })
        .from(tagPlanItems)
        .where(eq(tagPlanItems.tagPlanId, planId))
        .groupBy(tagPlanItems.status);
      const progress: Record<string, number> = { pending: 0, applying: 0, applied: 0, failed: 0, skipped: 0, reverted: 0, total: 0 };
      for (const c of counts) {
        progress[c.status ?? 'pending'] = (progress[c.status ?? 'pending'] ?? 0) + c.n;
        progress['total'] = (progress['total'] ?? 0) + c.n;
      }

      // A draft is waiting on its preview; say what that job is doing so the
      // page can show it instead of a bare spinner (and link to it).
      const previewJob = plan.status === 'draft' ? await latestPreviewJob(db, planId) : undefined;

      const formatted: TagPlan & { progress: Record<string, number>; previewJob?: TagPlanPreviewJob } = {
        id: plan.id,
        libraryId: plan.libraryId,
        name: plan.name,
        scope: scopeData as TagPlanScope,
        policy: policyData as TagPolicies,
        status: plan.status as any,
        stats: statsData ?? { filesTouched: 0, fieldsModified: 0, lockedFieldsRespected: 0, filesSkipped: [] },
        createdBy: plan.createdBy,
        createdAt: plan.createdAt.toISOString(),
        appliedAt: plan.appliedAt?.toISOString(),
        progress,
        ...(previewJob ? { previewJob } : {}),
      };

      reply.send(formatted);
    }
  );

  /**
   * GET /api/v1/libraries/:libraryId/tag-plans/:planId/items
   * Get filtered plan items with optional field and album filters
   */
  fastify.get<{
    Params: { libraryId: string; planId: string };
    Querystring: { field?: string; album?: string };
  }>(
    '/tag-plans/:planId/items',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
      const { field, album, status: statusQ } = request.query as { field?: string; album?: string; status?: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      // One page of items, path included, ordered by path so the table reads
      // like the folder. A field filter narrows to files that change that
      // field (jsonb containment) and trims each row's diffs to it.
      const q = request.query as { field?: string; album?: string; limit?: string; offset?: string };
      const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
      const conds = [eq(tagPlanItems.tagPlanId, planId)];
      if (field) conds.push(sql`${tagPlanItems.diff} @> ${JSON.stringify([{ field }])}::jsonb`);
      if (album) {
        conds.push(sql`${tagPlanItems.audioFileId} in (select lt.audio_file_id from local_tracks lt where lt.local_album_id = ${album})`);
      }
      if (statusQ && ['pending', 'applying', 'applied', 'failed', 'skipped'].includes(statusQ)) {
        conds.push(eq(tagPlanItems.status, statusQ));
      }
      const where = and(...conds);

      const [[count], rows] = await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(tagPlanItems).where(where),
        db
          .select({
            id: tagPlanItems.id,
            planId: tagPlanItems.tagPlanId,
            audioFileId: tagPlanItems.audioFileId,
            relPath: audioFiles.relPath,
            status: tagPlanItems.status,
            error: tagPlanItems.error,
            diffs: tagPlanItems.diff,
          })
          .from(tagPlanItems)
          .innerJoin(audioFiles, eq(audioFiles.id, tagPlanItems.audioFileId))
          .where(where)
          .orderBy(audioFiles.relPath)
          .limit(limit)
          .offset(offset),
      ]);

      const formatted: TagPlanItem[] = rows.map((item) => ({
        id: item.id,
        planId: item.planId,
        audioFileId: item.audioFileId,
        relPath: item.relPath,
        status: (item.status ?? 'pending') as TagPlanItem['status'],
        ...(item.error ? { error: item.error } : {}),
        diffs: ((item.diffs as any[]) || []).filter((d: any) => !field || d.field === field),
      }));

      reply.send({ items: formatted, total: count?.n ?? 0, limit, offset });
    }
  );

  /**
   * GET /api/v1/libraries/:libraryId/tag-plans/:planId/summary
   * What the plan changes, aggregated: one row per (field, reason) with the
   * number of files, so a large plan reads as "date: 4,120 overwrite" before
   * anyone scrolls a table.
   */
  fastify.get<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/summary',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }
      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
      const db = getDb();
      const lib = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');
      const plan = await db
        .select({ id: tagPlans.id })
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));
      if (plan.length === 0) throw new ApiError(404, 'Not Found', 'Tag plan not found');

      const rows = (await db.execute(sql`
        select d->>'field' as field, d->>'reason' as reason, count(*)::int as files
        from tag_plan_items i, jsonb_array_elements(i.diff) d
        where i.tag_plan_id = ${planId} and d->>'reason' <> 'no-change'
        group by 1, 2
        order by 3 desc, 1`)) as unknown as Array<{ field: string; reason: string; files: number }>;
      const statuses = (await db.execute(sql`
        select status, count(*)::int as files from tag_plan_items where tag_plan_id = ${planId} group by 1`)) as unknown as Array<{ status: string; files: number }>;

      reply.send({
        fields: rows.map((r) => ({ field: r.field, reason: r.reason, files: Number(r.files) })),
        statuses: Object.fromEntries(statuses.map((r) => [r.status, Number(r.files)])),
      });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/preview
   * Enqueue the tags.preview job for this plan
   * Returns immediately with job ID; plan status becomes 'previewed' when job completes
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/preview',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;
      if (plan.status !== 'draft') {
        throw new ApiError(400, 'Bad Request', `Cannot preview plan in status '${plan.status}'`);
      }

      // Enqueue the tags.preview job with singletonKey.
      //
      // The guard below is the one that matters. The plan page auto-previews a
      // draft when it mounts, so every visit to a plan whose preview has not
      // finished used to queue another job: one production plan collected three
      // in a day, all against the same files. singletonKey alone does not stop
      // this, because a queue policy only constrains jobs in one state, so a
      // fresh send lands behind an active one rather than being dropped.
      //
      // Ask the queue directly instead. If a preview for this plan is already
      // waiting or running, return that job and say so, so a client that asks
      // twice is harmless.
      const boss = await getBoss();
      const singletonKey = `tag_plan:${planId}`;

      const existing = (await db.execute(sql`
        select id::text as id, state from pgboss.job
         where name = 'tags.preview'
           and data->>'planId' = ${planId}
           and state in ('created', 'active', 'retry')
         order by created_on desc limit 1`)) as unknown as Array<{ id: string; state: string }>;

      if (existing[0]) {
        reply.status(202).send({
          jobId: existing[0].id,
          singletonKey,
          alreadyRunning: true,
          message: `Preview already ${existing[0].state === 'active' ? 'running' : 'queued'} for this plan`,
        });
        return;
      }

      const jobId = await boss.send('tags.preview', { planId }, {
        singletonKey,
      });

      reply.status(202).send({
        jobId,
        singletonKey,
        alreadyRunning: false,
        message: 'Preview job enqueued',
      });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/apply
   * Enqueue the tags.apply job for this plan
   * Returns immediately with job ID; plan status becomes 'applying' then 'applied' when job completes
   * Refuses with 403 unless settings.tagWritesEnabled === true AND all scan roots are writable
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/apply',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      const libRecord = lib[0]!;

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      // Check refusal conditions: tagWritesEnabled and scan root writability
      const tagWritesEnabled = (libRecord.settings as any)?.tagWritesEnabled === true;

      if (!tagWritesEnabled) {
        throw new ApiError(403, 'Forbidden', 'Tag writes are not enabled for this library');
      }

      // Plan must be in 'previewed' or 'paused' status to apply
      if (!['previewed', 'paused'].includes(plan.status as string)) {
        throw new ApiError(400, 'Bad Request', `Cannot apply plan in status '${plan.status}'`);
      }

      // Get all items in the plan to check scan root writability
      const items = await db
        .select({ audioFileId: tagPlanItems.audioFileId })
        .from(tagPlanItems)
        .where(eq(tagPlanItems.tagPlanId, planId));

      if (items.length > 0) {
        // Get all audio files to find their scan roots
        const audioFileIds = items.map((i) => i.audioFileId);
        const files = await db
          .select({ scanRootId: audioFiles.scanRootId })
          .from(audioFiles)
          .where(inArray(audioFiles.id, audioFileIds));

        // Get unique scan root IDs
        const scanRootIds = Array.from(new Set(files.map((f) => f.scanRootId)));

        // Check that all scan roots are writable
        const roots = await db
          .select({ id: scanRoots.id, writable: scanRoots.writable })
          .from(scanRoots)
          .where(inArray(scanRoots.id, scanRootIds));

        const nonWritableRoots = roots.filter((r) => !r.writable);
        if (nonWritableRoots.length > 0) {
          throw new ApiError(403, 'Forbidden', 'Not all scan roots are writable');
        }
      }

      // Enqueue the tags.apply job with singletonKey
      const boss = await getBoss();
      const singletonKey = `tags.apply:${planId}`;
      const jobId = await boss.send('tags.apply', { planId }, {
        singletonKey,
      });

      reply.status(202).send({
        jobId,
        singletonKey,
        message: 'Apply job enqueued',
      });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/pause
   * Pause an applying tag plan
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/pause',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      if (plan.status !== 'applying') {
        throw new ApiError(400, 'Bad Request', `Cannot pause plan in status '${plan.status}'`);
      }

      // Update plan status to paused
      await db
        .update(tagPlans)
        .set({ status: 'paused' })
        .where(eq(tagPlans.id, planId));

      reply.send({ status: 'paused', message: 'Plan paused' });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/resume
   * Resume a paused tag plan
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/resume',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      if (plan.status !== 'paused') {
        throw new ApiError(400, 'Bad Request', `Cannot resume plan in status '${plan.status}'`);
      }

      // Enqueue the tags.apply job to resume processing
      const boss = await getBoss();
      const singletonKey = `tags.apply:${planId}`;
      const jobId = await boss.send('tags.apply', { planId }, {
        singletonKey,
      });

      reply.status(202).send({
        jobId,
        singletonKey,
        message: 'Apply job re-enqueued',
      });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/cancel
   * Cancel an applying or paused tag plan
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/cancel',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      if (!['applying', 'paused'].includes(plan.status as string)) {
        throw new ApiError(400, 'Bad Request', `Cannot cancel plan in status '${plan.status}'`);
      }

      // Update plan status to cancelled
      await db
        .update(tagPlans)
        .set({ status: 'cancelled' })
        .where(eq(tagPlans.id, planId));

      reply.send({ status: 'cancelled', message: 'Plan cancelled' });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/revert
   * Enqueue the tags.revert job to build a revert plan from an applied plan
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/revert',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      if (plan.status !== 'applied' && plan.status !== 'partially_failed') {
        throw new ApiError(400, 'Bad Request', `Cannot revert plan in status '${plan.status}'`);
      }

      // Enqueue the tags.revert job
      const boss = await getBoss();
      const jobId = await boss.send('tags.revert', { planId }, {
        singletonKey: `tags.revert:${planId}`,
      });

      reply.status(202).send({
        jobId,
        singletonKey: `tags.revert:${planId}`,
        message: 'Revert job enqueued',
      });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-plans/:planId/add-items
   * Add albums to a plan that has not been applied yet (album page "Fix tags"
   * → "add to an existing plan"). Only plans scoped to a list of albums can
   * grow; artist and library plans already cover what they cover.
   *
   * Adding albums makes the old preview wrong, so in one transaction the plan
   * goes back to draft, its stats are cleared and its pending rows are
   * dropped; then a fresh preview is queued. Adding albums that are already
   * in the plan changes nothing and returns 200.
   *
   * A preview that was already running when the albums arrived finishes with
   * the old album list; the worker only marks the plan previewed when the
   * scope it read is still the plan's scope, and the preview queued here
   * redoes it.
   */
  fastify.post<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId/add-items',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
      const db = getDb();

      const lib = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      const body = addItemsSchema.parse(request.body);
      const requested = Array.from(new Set(body.scope.albumIds));

      // Every album must belong to this library: the preview job trusts the
      // plan's album ids and does not filter by library itself.
      const known = await db
        .select({ id: localAlbums.id })
        .from(localAlbums)
        .where(and(eq(localAlbums.libraryId, libraryId), inArray(localAlbums.id, requested)));
      if (known.length !== requested.length) {
        throw new ApiError(400, 'Bad Request', 'Some of these albums are not in this library.');
      }

      const result = await db.transaction(async (tx) => {
        // Lock the plan row so a second add waits for this one.
        const [plan] = await tx
          .select()
          .from(tagPlans)
          .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)))
          .for('update');
        if (!plan) {
          throw new ApiError(404, 'Not Found', 'Tag plan not found');
        }
        if (!OPEN_PLAN_STATUSES.includes(plan.status as string)) {
          throw new ApiError(409, 'Conflict', PLAN_CLOSED);
        }

        const existingScope = (typeof plan.scope === 'string' ? JSON.parse(plan.scope) : plan.scope) as TagPlanScope;
        if (existingScope.type !== 'albumIds') {
          throw new ApiError(409, 'Conflict', 'This plan covers an artist or the whole library, so albums cannot be added to it. Start a new plan instead.');
        }

        // Apply was accepted but its job has not moved the plan to applying
        // yet: resetting now would leave that job with nothing to write.
        const applyQueued = (await tx.execute(sql`
          select 1 from pgboss.job
           where name = 'tags.apply'
             and data->>'planId' = ${planId}
             and state in ('created', 'active', 'retry')
           limit 1`)) as unknown as unknown[];
        if (applyQueued.length > 0) {
          throw new ApiError(409, 'Conflict', PLAN_CLOSED);
        }

        const merged = Array.from(new Set([...existingScope.albumIds, ...requested]));
        const added = merged.length - existingScope.albumIds.length;
        if (added === 0) {
          return { added: 0, albumCount: merged.length, status: plan.status as string };
        }

        // The status condition repeats the check above inside the write, so
        // nothing that moved the plan on in between gets reset to draft.
        const updated = await tx
          .update(tagPlans)
          .set({ scope: { type: 'albumIds', albumIds: merged }, status: 'draft', stats: {} })
          .where(and(eq(tagPlans.id, planId), inArray(tagPlans.status, OPEN_PLAN_STATUSES)))
          .returning({ id: tagPlans.id });
        if (updated.length === 0) {
          throw new ApiError(409, 'Conflict', PLAN_CLOSED);
        }
        // The old preview's rows describe the old album list.
        await tx
          .delete(tagPlanItems)
          .where(and(eq(tagPlanItems.tagPlanId, planId), inArray(tagPlanItems.status, ['pending', 'applying'])));

        return { added, albumCount: merged.length, status: 'draft' };
      });

      let previewQueued = false;
      if (result.added > 0) {
        // Same singleton key as the preview route. The queue is 'stately': a
        // preview already waiting absorbs this one (it reads the new scope
        // when it starts); one already running gets a successor.
        const boss = await getBoss();
        await boss.send('tags.preview', { planId }, { singletonKey: `tag_plan:${planId}` });
        previewQueued = true;
      }

      reply.status(200).send({ planId, ...result, previewQueued });
    }
  );

  /**
   * POST /api/v1/libraries/:libraryId/tag-edit/suggest
   * Body { scope } (albumIds or folder). What the files in the selection carry
   * today and the album-level values the bulk editor starts from: the album
   * artist with a baked-in track number stripped, "Various Artists" and the
   * compilation flag when the track artists differ. Reads only.
   */
  fastify.post<{ Params: { libraryId: string } }>(
    '/tag-edit/suggest',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }
      const { libraryId } = request.params as { libraryId: string };
      const db = getDb();
      const lib = await db
        .select({ id: libraries.id })
        .from(libraries)
        .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
      if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

      const parsed = tagPlanScopeSchema.safeParse((request.body as { scope?: unknown } | null)?.scope);
      if (!parsed.success || (parsed.data.type !== 'albumIds' && parsed.data.type !== 'folder')) {
        throw new ApiError(400, 'Bad Request', 'scope must be { type: "albumIds", albumIds } or { type: "folder", dirPath }');
      }
      const albumIds = await resolveEditableScope(db, libraryId, parsed.data);
      if (albumIds.length === 0) throw new ApiError(404, 'Not Found', 'No albums in this selection');
      const files = await filesOfAlbums(db, albumIds);
      reply.send({ albumIds, ...suggestBulkValues(files, albumIds.length) });
    }
  );

  /**
   * DELETE /api/v1/libraries/:libraryId/tag-plans/:planId
   * Delete a tag plan and its items
   * Refuses with 409 if the plan is currently applying
   */
  fastify.delete<{ Params: { libraryId: string; planId: string } }>(
    '/tag-plans/:planId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, planId } = request.params as { libraryId: string; planId: string };
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

      // Verify plan exists and belongs to library
      const plans = await db
        .select()
        .from(tagPlans)
        .where(and(eq(tagPlans.id, planId), eq(tagPlans.libraryId, libraryId)));

      if (plans.length === 0) {
        throw new ApiError(404, 'Not Found', 'Tag plan not found');
      }

      const plan = plans[0]!;

      // Refuse to delete a plan that is currently applying
      if (plan.status === 'applying') {
        throw new ApiError(409, 'Conflict', 'Cannot delete a plan while it is currently applying');
      }

      // Delete the plan and its items (items cascade due to foreign key)
      await db.delete(tagPlans).where(eq(tagPlans.id, planId));

      reply.status(204).send();
    }
  );
}

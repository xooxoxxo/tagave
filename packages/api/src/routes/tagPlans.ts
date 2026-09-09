import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
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
  type TagPlan,
  type TagPlanItem,
  type TagPlanScope,
  type TagPolicies,
} from '@liner/shared';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { albumQueryParts } from './albums.js';

/**
 * Register tag plan routes.
 * Per Spec §13 and TAG-2/TAG-3: Tag plans API endpoints
 * - GET /api/v1/libraries/:libraryId/tag-plans (list with pagination)
 * - POST /api/v1/libraries/:libraryId/tag-plans (create new plan)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId (fetch)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId/items (filtered items)
 * - POST /api/v1/libraries/:libraryId/tag-plans/:planId/preview (enqueue preview job)
 */
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
      default: return 'Unknown scope';
    }
  });
}

export async function createTagPlansRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/libraries/:libraryId/tag-plans
   * List tag plans with pagination
   */
  fastify.get<{ Params: { libraryId: string }; Querystring: { limit?: string; offset?: string } }>(
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

      // Get total count
      const countResult = await db
        .select({ count: count() })
        .from(tagPlans)
        .where(eq(tagPlans.libraryId, libraryId));

      const total = countResult[0]?.count ?? 0;

      // Get paginated plans, ordered by created_at desc
      const plans = await db
        .select()
        .from(tagPlans)
        .where(eq(tagPlans.libraryId, libraryId))
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

      const body = createTagPlanSchema.parse(request.body);

      // A filter scope is resolved to the matching album ids now — the worker
      // has no query builder — so the plan records what the filter meant today.
      let scope: TagPlanScope = body.scope;
      if (scope.type === 'filterQuery') {
        const { conds } = albumQueryParts(libraryId, request.user.id, scope.filterQuery as Record<string, unknown>);
        const rows = await db.select({ id: localAlbums.id }).from(localAlbums).where(and(...conds));
        if (rows.length === 0) throw new ApiError(400, 'Bad Request', 'The filter matches no albums');
        scope = { type: 'albumIds', albumIds: rows.map((r) => r.id) };
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

      const formatted: TagPlan & { progress: Record<string, number> } = {
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

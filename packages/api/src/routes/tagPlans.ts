import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { and, eq, inArray, count, desc } from 'drizzle-orm';
import {
  tagPlans,
  tagPlanItems,
  audioFiles,
  localAlbums,
  localTracks,
  libraries,
  scanRoots,
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

/**
 * Register tag plan routes.
 * Per Spec §13 and TAG-2/TAG-3: Tag plans API endpoints
 * - GET /api/v1/libraries/:libraryId/tag-plans (list with pagination)
 * - POST /api/v1/libraries/:libraryId/tag-plans (create new plan)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId (fetch)
 * - GET /api/v1/libraries/:libraryId/tag-plans/:planId/items (filtered items)
 * - POST /api/v1/libraries/:libraryId/tag-plans/:planId/preview (enqueue preview job)
 */
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

      const formatted: TagPlan[] = plans.map((p) => {
        const scopeData = typeof p.scope === 'string' ? JSON.parse(p.scope) : p.scope;
        const policyData = typeof p.policy === 'string' ? JSON.parse(p.policy) : p.policy;
        const statsData = typeof p.stats === 'string' ? JSON.parse(p.stats) : p.stats;
        return {
          id: p.id,
          libraryId: p.libraryId,
          name: p.name,
          scope: scopeData as TagPlanScope,
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

      const planId = uuidv7();
      const now = new Date();

      await db.insert(tagPlans).values({
        id: planId,
        libraryId,
        name: body.name,
        scope: body.scope,
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
      const { field, album } = request.query as { field?: string; album?: string };
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

      // Get all items for this plan
      let items = await db
        .select({
          id: tagPlanItems.id,
          planId: tagPlanItems.tagPlanId,
          audioFileId: tagPlanItems.audioFileId,
          diffs: tagPlanItems.diff,
        })
        .from(tagPlanItems)
        .where(eq(tagPlanItems.tagPlanId, planId));

      // Filter by album if provided
      if (album) {
        // Get all tracks for the album
        const tracksForAlbum = await db
          .select({ audioFileId: localTracks.audioFileId })
          .from(localTracks)
          .where(eq(localTracks.localAlbumId, album));

        const audioFileIdsForAlbum = new Set(tracksForAlbum.map((t) => t.audioFileId));
        items = items.filter((item) => audioFileIdsForAlbum.has(item.audioFileId));
      }

      // Filter by field if provided and format response
      const formatted: TagPlanItem[] = (items as any[])
        .filter((item) => {
          if (!field) return true;
          const diffs = item.diffs as any[];
          return diffs && diffs.some((d: any) => d.field === field);
        })
        .map((item) => ({
          id: item.id,
          planId: item.planId,
          audioFileId: item.audioFileId,
          diffs: (item.diffs as any[] || []).filter((d: any) => !field || d.field === field),
        }));

      reply.send({ items: formatted });
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

      // Enqueue the tags.preview job with singletonKey
      const boss = await getBoss();
      const singletonKey = `tag_plan:${planId}`;
      const jobId = await boss.send('tags.preview', { planId }, {
        singletonKey,
      });

      reply.status(202).send({
        jobId,
        singletonKey,
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
}

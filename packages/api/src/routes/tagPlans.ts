import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { and, eq } from 'drizzle-orm';
import {
  tagPlans,
  tagPlanItems,
  audioFiles,
  localAlbums,
  localTracks,
  libraries,
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
  fastify.get<{ Params: { libraryId: string } }>(
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

      // TODO: Implement pagination
      const plans = await db
        .select()
        .from(tagPlans)
        .where(eq(tagPlans.libraryId, libraryId));

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

      reply.send({ items: formatted });
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
}

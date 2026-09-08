/**
 * Bulk actions on an album selection (spec §14.2: multi-select with
 * Shift/⌘ for bulk actions). The selection is either an explicit id list or
 * "everything matching the current grid filters"; both are resolved to ids
 * inside the owner's library, and job-producing actions are capped so one
 * click cannot flood the shared provider budget.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { libraries, localAlbums } from '@liner/db';
import {
  BULK_JOB_CAP, BULK_UPDATE_CAP, bulkAlbumsRequestSchema,
  type BulkAlbumAction, type BulkAlbumsResult,
} from '@liner/shared';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { ApiError } from '../middleware/errorHandler.js';
import { albumQueryParts, bustFacetCache } from './albums.js';

const CHUNK = 500;
const QUEUES: Partial<Record<BulkAlbumAction, string>> = { identify: 'identify.album', fetch_art: 'art.fetch' };
// Job priority tiers (see api/src/lib/identifyRequests.ts): manual single-album
// pins 100, triage retries and bulk 50, background sweeps 0 — a bulk run of up
// to 2,000 albums jumps the sweep but never an owner's click on one album.
const BULK_JOB_PRIORITY = 50;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const idList = (ids: string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

export async function createBulkRoutes(fastify: FastifyInstance) {
  fastify.post('/libraries/:libraryId/albums/bulk', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const db = getDb();
    const lib = await db.select({ id: libraries.id }).from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

    const parsed = bulkAlbumsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(400, 'Bad Request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
    }
    const { action, albumIds, allMatching, query } = parsed.data;
    const cap = QUEUES[action] ? BULK_JOB_CAP : BULK_UPDATE_CAP;

    // Resolve the selection to ids that belong to this library (an explicit
    // list from the client is filtered the same way as "all matching").
    const selection = allMatching
      ? and(...albumQueryParts(libraryId, request.user.id, (query ?? {}) as Record<string, unknown>).conds)!
      : and(eq(localAlbums.libraryId, libraryId), sql`${localAlbums.id} in ${idList(albumIds ?? [])}`)!;
    const rows = await db.select({ id: localAlbums.id }).from(localAlbums).where(selection).limit(cap + 1);
    const capped = rows.length > cap;
    const ids = rows.slice(0, cap).map((r) => r.id);

    const result: BulkAlbumsResult = { action, matched: ids.length, updated: 0, queued: 0, skippedAlreadyQueued: 0, capped };
    if (ids.length === 0) {
      reply.send(result);
      return;
    }

    const queue = QUEUES[action];
    if (queue) {
      // One statement per chunk instead of a send() round trip per album; the
      // queues are 'stately', so ON CONFLICT collapses albums already waiting.
      await getBoss(); // ensures the queues exist before the first raw insert
      const data = action === 'identify'
        ? sql`jsonb_build_object('localAlbumId', la.id::text, 'force', true)`
        : sql`jsonb_build_object('localAlbumId', la.id::text)`;
      const keyPrefix = action === 'identify' ? 'identify:' : 'art:';
      for (const chunk of chunks(ids)) {
        const inserted = await db.execute(sql`
          insert into pgboss.job (name, data, policy, singleton_key, priority)
          select ${queue}, ${data}, 'stately', ${keyPrefix} || la.id::text, ${BULK_JOB_PRIORITY}
          from local_albums la where la.id in ${idList(chunk)}
          on conflict do nothing
          returning 1`) as unknown as unknown[];
        result.queued += inserted.length;
        result.skippedAlreadyQueued += chunk.length - inserted.length;
        // Albums the conflict skipped already wait in the queue — usually as a
        // priority-0 sweep job; lift those so the bulk run still jumps the sweep.
        const keys = sql`(${sql.join(chunk.map((id) => sql`${keyPrefix + id}`), sql`, `)})`;
        await db.execute(sql`
          update pgboss.job set priority = ${BULK_JOB_PRIORITY}
          where name = ${queue} and singleton_key in ${keys}
            and state = 'created' and priority < ${BULK_JOB_PRIORITY}`);
      }
      bustFacetCache(libraryId);
      reply.send(result);
      return;
    }

    for (const chunk of chunks(ids)) {
      const where = sql`library_id = ${libraryId} and id in ${idList(chunk)}`;
      if (action === 'ignore' || action === 'as_is') {
        const state = action === 'ignore' ? 'ignored' : 'as_is';
        const updated = await db.execute(sql`
          update local_albums set state = ${state}, updated_at = now() where ${where} returning 1`) as unknown as unknown[];
        result.updated += updated.length;
      } else if (action === 'unignore') {
        // Back to where identification left it: matched when a live match
        // exists, otherwise pending so the sweep picks the album up again.
        const updated = await db.execute(sql`
          update local_albums set state = case when release_id is not null then 'matched' else 'pending' end,
                                  updated_at = now()
          where ${where} and state in ('ignored', 'as_is') returning 1`) as unknown as unknown[];
        result.updated += updated.length;
      } else if (action === 'prefer') {
        // GAP-4: exactly one preferred copy per release group.
        const updated = await db.execute(sql`
          update local_albums set preferred = true, updated_at = now() where ${where} returning 1`) as unknown as unknown[];
        await db.execute(sql`
          update local_albums sibling set preferred = false, updated_at = now()
          from local_albums picked
          where picked.id in ${idList(chunk)}
            and sibling.library_id = ${libraryId}
            and sibling.release_group_id = picked.release_group_id
            and sibling.release_group_id is not null
            and sibling.id <> picked.id
            and sibling.preferred`);
        result.updated += updated.length;
      }
    }
    // The grid refetches facet counts right after a bulk action; the 15 s
    // facet cache would otherwise hand back the pre-action counts.
    bustFacetCache(libraryId);
    reply.send(result);
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  libraries, collectionSources, collectionItems, releases, releaseGroups, localAlbums,
} from '@liner/db';
import PgBoss from 'pg-boss';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

let bossSingleton: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
    await bossSingleton.createQueue('collection.sync');
  }
  return bossSingleton;
}

export async function createCollectionRoutes(fastify: FastifyInstance) {
  // GET /libraries/:lib/collection-sources — list sources with counts
  fastify.get('/libraries/:lib/collection-sources', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib } = request.params as { lib: string };
    const db = getDb();

    // Verify library ownership
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Get sources
    const sources = await db
      .select()
      .from(collectionSources)
      .where(eq(collectionSources.libraryId, lib));

    // Get counts for each source
    const sourceIds = sources.map(s => s.id);
    const counts = sourceIds.length > 0
      ? await db.execute(sql`
          select collection_source_id,
                 count(*)::int as total,
                 count(*) filter (where mapping_state != 'unmapped' and removed_at is null)::int as mapped,
                 count(*) filter (where mapping_state = 'unmapped' and removed_at is null)::int as unmapped,
                 count(*) filter (where removed_at is not null)::int as removed
          from collection_items
          where collection_source_id in ${sql`(${sql.join(sourceIds.map(id => sql`${id}`), sql`, `)})`}
          group by collection_source_id
        `)
      : [];

    const countMap = new Map(
      (counts as unknown as Array<{
        collection_source_id: string;
        total: number;
        mapped: number;
        unmapped: number;
        removed: number;
      }>).map(c => [c.collection_source_id, c])
    );

    reply.status(200).send({
      sources: sources.map(s => {
        const c = countMap.get(s.id) ?? {
          total: 0, mapped: 0, unmapped: 0, removed: 0,
        };
        return {
          id: s.id,
          provider: s.provider,
          username: s.username,
          status: s.status,
          lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
          counts: {
            total: c.total,
            mapped: c.mapped,
            unmapped: c.unmapped,
            removed: c.removed,
          },
        };
      }),
    });
  });

  // POST /libraries/:lib/collection-sources/sync — enqueue sync
  fastify.post('/libraries/:lib/collection-sources/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib } = request.params as { lib: string };
    const db = getDb();

    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: lib }, {
      singletonKey: `collection-sync:${lib}`,
    });

    reply.status(202).send({ ok: true });
  });

  // POST /collection-sources/:id/sync — same as above
  fastify.post('/collection-sources/:id/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const db = getDb();

    // Find the source and verify ownership
    const sources = await db
      .select()
      .from(collectionSources)
      .where(eq(collectionSources.id, id));

    if (sources.length === 0) {
      throw new ApiError(404, 'Not Found', 'Collection source not found');
    }

    const source = sources[0]!;
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(
        eq(libraries.id, source.libraryId),
        eq(libraries.ownerUserId, request.user.id)
      ));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: source.libraryId }, {
      singletonKey: `collection-sync:${source.libraryId}`,
    });

    reply.status(202).send({ ok: true });
  });

  // GET /libraries/:lib/collection — list items with filters
  fastify.get('/libraries/:lib/collection', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib } = request.params as { lib: string };
    const { view = 'all', folder, q, limit = '50', offset = '0' } = request.query as Record<string, string>;
    const db = getDb();

    // Verify library ownership
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Build filter
    const conds = [eq(collectionItems.libraryId, lib)];

    // Filter by view (spec GAP-3: physical_only and both differentiated by localAlbumMap presence)
    if (view === 'physical_only' || view === 'both') {
      // Both require mapped items (release_group_id not null) that are not removed
      conds.push(sql`${collectionItems.releaseGroupId} is not null and ${collectionItems.removedAt} is null`);
    } else if (view === 'unmapped') {
      conds.push(eq(collectionItems.mappingState, 'unmapped'));
      conds.push(sql`${collectionItems.removedAt} is null`);
    } else if (view === 'removed') {
      conds.push(sql`${collectionItems.removedAt} is not null`);
    }

    if (folder) {
      conds.push(eq(collectionItems.folderId, parseInt(folder, 10)));
    }

    if (q) {
      conds.push(sql`
        (${collectionItems.basicInfo}->>'title' ilike ${'%' + q + '%'} or
         exists (select 1 from jsonb_array_elements_text(${collectionItems.basicInfo}->'artists') as artist where artist ilike ${'%' + q + '%'}))
      `);
    }

    // Query items
    const items = await db
      .select()
      .from(collectionItems)
      .where(and(...conds))
      .limit(Math.min(parseInt(limit, 10), 500))
      .offset(parseInt(offset, 10));

    // Enrich with local albums
    const releaseGroupIds = items.filter(i => i.releaseGroupId).map(i => i.releaseGroupId!);
    const localAlbumMap = new Map<string, Array<any>>();
    if (releaseGroupIds.length > 0) {
      const localAlbs = await db
        .select({
          id: localAlbums.id,
          title: localAlbums.titleGuess,
          artist: localAlbums.artistGuess,
          state: localAlbums.state,
          formats: localAlbums.formats,
          releaseGroupId: localAlbums.releaseGroupId,
        })
        .from(localAlbums)
        .where(and(
          eq(localAlbums.libraryId, lib),
          inArray(localAlbums.releaseGroupId, releaseGroupIds),
          sql`${localAlbums.state} != 'ignored'`
        ));

      for (const alb of localAlbs) {
        if (alb.releaseGroupId) {
          if (!localAlbumMap.has(alb.releaseGroupId)) {
            localAlbumMap.set(alb.releaseGroupId, []);
          }
          localAlbumMap.get(alb.releaseGroupId)!.push(alb);
        }
      }
    }

    const limitN = parseInt(limit, 10);
    const offsetN = parseInt(offset, 10);

    // Post-filter for physical_only vs both based on localAlbumMap (spec GAP-3)
    const filteredItems = (view === 'physical_only' || view === 'both')
      ? items.filter(item => {
        const hasLocalAlbums = item.releaseGroupId && localAlbumMap.has(item.releaseGroupId) && (localAlbumMap.get(item.releaseGroupId)?.length ?? 0) > 0;
        return view === 'physical_only' ? !hasLocalAlbums : hasLocalAlbums;
      })
      : items;

    reply.status(200).send({
      items: filteredItems.map(item => ({
        id: item.id,
        discogsReleaseId: item.discogsReleaseId,
        discogsMasterId: item.discogsMasterId,
        folderId: item.folderId,
        folderName: item.folderName,
        dateAdded: item.dateAdded?.toISOString(),
        rating: item.rating,
        mediaCondition: item.mediaCondition,
        sleeveCondition: item.sleeveCondition,
        notes: item.notes,
        formats: item.formats,
        mappingState: item.mappingState,
        mappingSource: item.mappingSource,
        releaseId: item.releaseId,
        releaseGroupId: item.releaseGroupId,
        basicInfo: item.basicInfo,
        localAlbums: item.releaseGroupId ? (localAlbumMap.get(item.releaseGroupId) ?? []) : [],
        discogsUrl: `https://www.discogs.com/release/${item.discogsReleaseId}`,
      })),
      nextCursor: items.length === limitN ? String(offsetN + limitN) : null,
    });
  });

  // POST /collection-items/:id/map — manual mapping
  fastify.post('/collection-items/:id/map', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const { releaseId } = (request.body ?? {}) as { releaseId?: string };

    if (!releaseId) {
      throw new ApiError(400, 'Bad Request', 'releaseId required');
    }

    const db = getDb();

    // Find item and verify ownership
    const items = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.id, id));

    if (items.length === 0) {
      throw new ApiError(404, 'Not Found', 'Collection item not found');
    }

    const item = items[0]!;
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(
        eq(libraries.id, item.libraryId),
        eq(libraries.ownerUserId, request.user.id)
      ));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Get the release to find release_group_id
    const releases_rows = await db
      .select()
      .from(releases)
      .where(eq(releases.id, releaseId));

    if (releases_rows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Release not found');
    }

    const rel = releases_rows[0]!;
    await db.update(collectionItems)
      .set({
        releaseId,
        releaseGroupId: rel.releaseGroupId,
        mappingState: 'manual',
        mappingSource: 'manual',
        mappedAt: new Date(),
      })
      .where(eq(collectionItems.id, id));

    reply.status(200).send({ ok: true });
  });

  // DELETE /collection-items/:id/map — unmap
  fastify.delete('/collection-items/:id/map', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const db = getDb();

    const items = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.id, id));

    if (items.length === 0) {
      throw new ApiError(404, 'Not Found', 'Collection item not found');
    }

    const item = items[0]!;
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(
        eq(libraries.id, item.libraryId),
        eq(libraries.ownerUserId, request.user.id)
      ));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    await db.update(collectionItems)
      .set({
        releaseId: null,
        releaseGroupId: null,
        mappingState: 'unmapped',
        mappingSource: null,
        mappedAt: null,
      })
      .where(eq(collectionItems.id, id));

    reply.status(200).send({ ok: true });
  });
}

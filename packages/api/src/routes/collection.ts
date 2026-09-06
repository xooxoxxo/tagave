import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  libraries, collectionSources, collectionItems, releases, releaseGroups, localAlbums,
} from '@liner/db';
import PgBoss from 'pg-boss';
import { DiscogsProvider, openSecret, isSealed, parseDiscogsRef } from '@liner/core';
import { getDb } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

let bossSingleton: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
    await bossSingleton.createQueue('collection.sync');
    await bossSingleton.createQueue('collection.push');
    await bossSingleton.createQueue('collection.remove');
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
        pushState: item.pushState,
        pushError: item.pushError,
        localAlbumId: item.localAlbumId,
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

  // GET /libraries/:lib/collection-sources/options — options for adding to collection (spec COL-3)
  fastify.get('/libraries/:lib/collection-sources/options', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib } = request.params as { lib: string };
    const db = getDb();
    const appSecret = process.env.APP_SECRET;

    // Verify library ownership
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const libSettings = typeof libRows[0]!.settings === 'string'
      ? JSON.parse(libRows[0]!.settings)
      : (libRows[0]!.settings ?? {});

    const token = (libSettings as Record<string, any>).discogsToken;
    if (!token) {
      throw new ApiError(400, 'Bad Request', 'Discogs token not configured');
    }

    const unsealed = isSealed(token) && appSecret ? openSecret(token, appSecret) : token;
    const provider = new DiscogsProvider({
      token: unsealed,
      userAgent: 'Liner/1.0',
    });

    // Get identity and folders
    const identity = await provider.getIdentity({} as any);
    const folders = await provider.listCollectionFolders(identity.username, {} as any);
    const fields = await provider.getCollectionFields(identity.username, {} as any);

    // Find media condition field for condition grades
    const mediaConditionField = fields.find(f => f.name.toLowerCase().includes('media condition'));
    const conditionGrades = mediaConditionField?.options ?? [
      'Mint (M)',
      'Near Mint (NM or M-)',
      'Very Good Plus (VG+)',
      'Very Good (VG)',
      'Good Plus (G+)',
      'Good (G)',
      'Fair (F)',
      'Poor (P)',
    ];

    reply.status(200).send({
      username: identity.username,
      folders: folders
        .filter(f => f.id !== 0) // Exclude "All" folder
        .map(f => ({ id: f.id, name: f.name })),
      fields: fields.map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        ...(f.options ? { options: f.options } : {}),
      })),
      conditionGrades,
    });
  });

  // POST /libraries/:lib/albums/:id/collection — add album to collection (spec COL-3)
  fastify.post('/libraries/:lib/albums/:id/collection', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib, id: albumId } = request.params as { lib: string; id: string };
    const body = request.body as {
      discogsReleaseId?: number;
      input?: string;
      folderId?: number;
      mediaCondition?: string;
      sleeveCondition?: string;
      notes?: string;
      rating?: number;
    };

    const db = getDb();

    // Verify library and album ownership
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    const albumRows = await db
      .select()
      .from(localAlbums)
      .where(and(eq(localAlbums.id, albumId), eq(localAlbums.libraryId, lib)));

    if (albumRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Album not found');
    }

    const album = albumRows[0]!;

    // Resolve Discogs release ID
    let discogsReleaseId = body.discogsReleaseId;
    if (!discogsReleaseId) {
      if (body.input) {
        const parsed = parseDiscogsRef(body.input);
        if (!parsed || parsed.kind !== 'release') {
          throw new ApiError(400, 'Bad Request', 'Invalid Discogs release URL or ID');
        }
        discogsReleaseId = parsed.id;
      } else if (album.releaseId) {
        const relRows = await db
          .select()
          .from(releases)
          .where(eq(releases.id, album.releaseId));
        if (relRows[0]?.discogsReleaseId) {
          discogsReleaseId = relRows[0].discogsReleaseId;
        }
      }

      // Check editions if still no ID
      if (!discogsReleaseId && album.releaseGroupId) {
        const edRows = await db
          .select({ discogsReleaseId: releases.discogsReleaseId })
          .from(releases)
          .where(eq(releases.releaseGroupId, album.releaseGroupId))
          .limit(1);
        if (edRows[0]?.discogsReleaseId) {
          discogsReleaseId = edRows[0].discogsReleaseId;
        }
      }

      if (!discogsReleaseId) {
        throw new ApiError(400, 'Bad Request', 'select a Discogs release: pick an edition with a Discogs id or paste a Discogs release URL');
      }
    }

    // Get or create collection source
    const sources = await db
      .select()
      .from(collectionSources)
      .where(eq(collectionSources.libraryId, lib));

    let sourceId: string;
    if (sources.length === 0) {
      // Create source with placeholder identity
      const result = await db.insert(collectionSources).values({
        libraryId: lib,
        provider: 'discogs',
      }).returning({ id: collectionSources.id });
      sourceId = result[0]!.id;
    } else {
      sourceId = sources[0]!.id;
    }

    // Create collection item with push_state='pending'
    const folderId = body.folderId ?? 1;

    // Validate folderId (folder 0 "All" is read-only)
    if (folderId === 0) {
      throw new ApiError(400, 'Bad Request', 'Folder 0 is read-only and cannot be used for collection items');
    }

    // Validate rating range (0-5)
    if (body.rating !== undefined && (typeof body.rating !== 'number' || body.rating < 0 || body.rating > 5)) {
      throw new ApiError(400, 'Bad Request', 'Rating must be a number between 0 and 5');
    }

    const itemResult = await db.insert(collectionItems).values({
      libraryId: lib,
      collectionSourceId: sourceId,
      discogsReleaseId,
      ...(album.releaseId ? { releaseId: album.releaseId } : {}),
      ...(album.releaseGroupId ? { releaseGroupId: album.releaseGroupId } : {}),
      localAlbumId: album.id,
      folderId,
      folderName: 'Uncategorized',
      ...(body.mediaCondition ? { mediaCondition: body.mediaCondition } : {}),
      ...(body.sleeveCondition ? { sleeveCondition: body.sleeveCondition } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.rating ? { rating: body.rating } : {}),
      mappingState: 'manual',
      mappingSource: 'manual',
      mappedAt: new Date(),
      pushState: 'pending',
    }).returning({ id: collectionItems.id });

    const itemId = itemResult[0]!.id;

    // Enqueue push
    const boss = await getBoss();
    await boss.send('collection.push', { libraryId: lib, itemId }, {
      singletonKey: `collection-push:${itemId}`,
    });

    reply.status(202).send({ itemId });
  });

  // POST /libraries/:lib/collection/items — add direct collection item (spec COL-3)
  fastify.post('/libraries/:lib/collection/items', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { lib } = request.params as { lib: string };
    const body = request.body as {
      input: string;
      folderId?: number;
      mediaCondition?: string;
      sleeveCondition?: string;
      notes?: string;
      rating?: number;
    };

    if (!body.input) {
      throw new ApiError(400, 'Bad Request', 'input (Discogs release URL/ID) required');
    }

    const db = getDb();

    // Verify library ownership
    const libRows = await db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, lib), eq(libraries.ownerUserId, request.user.id)));

    if (libRows.length === 0) {
      throw new ApiError(404, 'Not Found', 'Library not found');
    }

    // Parse Discogs ref
    const parsed = parseDiscogsRef(body.input);
    if (!parsed || parsed.kind !== 'release') {
      throw new ApiError(400, 'Bad Request', 'Invalid Discogs release URL or ID');
    }

    // Get or create collection source
    const sources = await db
      .select()
      .from(collectionSources)
      .where(eq(collectionSources.libraryId, lib));

    let sourceId: string;
    if (sources.length === 0) {
      const result = await db.insert(collectionSources).values({
        libraryId: lib,
        provider: 'discogs',
      }).returning({ id: collectionSources.id });
      sourceId = result[0]!.id;
    } else {
      sourceId = sources[0]!.id;
    }

    // Create collection item
    const folderId = body.folderId ?? 1;

    // Validate folderId (folder 0 "All" is read-only)
    if (folderId === 0) {
      throw new ApiError(400, 'Bad Request', 'Folder 0 is read-only and cannot be used for collection items');
    }

    // Validate rating range (0-5)
    if (body.rating !== undefined && (typeof body.rating !== 'number' || body.rating < 0 || body.rating > 5)) {
      throw new ApiError(400, 'Bad Request', 'Rating must be a number between 0 and 5');
    }

    const itemResult = await db.insert(collectionItems).values({
      libraryId: lib,
      collectionSourceId: sourceId,
      discogsReleaseId: parsed.id,
      folderId,
      folderName: 'Uncategorized',
      ...(body.mediaCondition ? { mediaCondition: body.mediaCondition } : {}),
      ...(body.sleeveCondition ? { sleeveCondition: body.sleeveCondition } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
      ...(body.rating ? { rating: body.rating } : {}),
      mappingState: 'unmapped',
      pushState: 'pending',
    }).returning({ id: collectionItems.id });

    const itemId = itemResult[0]!.id;

    // Enqueue push
    const boss = await getBoss();
    await boss.send('collection.push', { libraryId: lib, itemId }, {
      singletonKey: `collection-push:${itemId}`,
    });

    reply.status(202).send({ itemId });
  });

  // DELETE /collection-items/:id — remove item (spec COL-3)
  fastify.delete('/collection-items/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { id } = request.params as { id: string };
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

    // If synced with provider_item_id, queue removal; else delete outright
    if (item.pushState === 'synced' && item.providerItemId) {
      const boss = await getBoss();
      await boss.send('collection.remove', { libraryId: item.libraryId, itemId: item.id }, {
        singletonKey: `collection-remove:${item.id}`,
      });
      // Mark as pending removal
      await db.update(collectionItems).set({ pushState: 'pending' }).where(eq(collectionItems.id, id));
    } else {
      // Never pushed, delete directly
      await db.delete(collectionItems).where(eq(collectionItems.id, id));
    }

    reply.status(202).send({ ok: true });
  });

  // POST /collection-items/:id/retry-push — retry failed push (spec COL-3)
  fastify.post('/collection-items/:id/retry-push', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { id } = request.params as { id: string };
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

    // Reset to pending and enqueue
    await db.update(collectionItems)
      .set({ pushState: 'pending', pushError: null })
      .where(eq(collectionItems.id, id));

    const boss = await getBoss();
    await boss.send('collection.push', { libraryId: item.libraryId, itemId: item.id }, {
      singletonKey: `collection-push:${item.id}`,
    });

    reply.status(202).send({ ok: true });
  });

  // GET /libraries/:lib/collection/reconciliation — physical↔digital reconciliation (spec XO-303, GAP-3)
  fastify.get('/libraries/:lib/collection/reconciliation', async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Count physical_only: mapped items with no local albums
    const physicalOnlyCount = await db.execute(sql`
      select count(*)::int as cnt
      from collection_items ci
      where ci.library_id = ${lib}
        and ci.release_group_id is not null
        and ci.removed_at is null
        and not exists (
          select 1 from local_albums la
          where la.library_id = ${lib}
            and la.release_group_id = ci.release_group_id
            and la.state != 'ignored'
        )
    `);

    // Count both: mapped items with local albums
    const bothCount = await db.execute(sql`
      select count(*)::int as cnt
      from collection_items ci
      where ci.library_id = ${lib}
        and ci.release_group_id is not null
        and ci.removed_at is null
        and exists (
          select 1 from local_albums la
          where la.library_id = ${lib}
            and la.release_group_id = ci.release_group_id
            and la.state != 'ignored'
        )
    `);

    // Count unmapped: unmapped items not removed
    const unmappedCount = await db.execute(sql`
      select count(*)::int as cnt
      from collection_items ci
      where ci.library_id = ${lib}
        and ci.mapping_state = 'unmapped'
        and ci.removed_at is null
    `);

    // Count digital_only: local albums with no collection items in their release group
    const digitalOnlyCount = await db.execute(sql`
      select count(distinct la.id)::int as cnt
      from local_albums la
      where la.library_id = ${lib}
        and la.state != 'ignored'
        and la.release_group_id is not null
        and not exists (
          select 1 from collection_items ci
          where ci.library_id = ${lib}
            and ci.release_group_id = la.release_group_id
            and ci.removed_at is null
        )
    `);

    // Get top 50 artists by physical_only count
    const byArtistRows = await db.execute(sql`
      with artist_stats as (
        select
          coalesce(
            la.artist_guess,
            (ci.basic_info->>'artists')::text
          ) as artist,
          count(*) filter (where not exists (
            select 1 from local_albums la2
            where la2.library_id = ${lib}
              and la2.release_group_id = ci.release_group_id
              and la2.state != 'ignored'
          ))::int as physical_only,
          count(*) filter (where exists (
            select 1 from local_albums la2
            where la2.library_id = ${lib}
              and la2.release_group_id = ci.release_group_id
              and la2.state != 'ignored'
          ))::int as both
        from collection_items ci
        left join local_albums la on la.id = ci.local_album_id
        where ci.library_id = ${lib}
          and ci.release_group_id is not null
          and ci.removed_at is null
        group by artist
      )
      select artist, physical_only, both
      from artist_stats
      where physical_only > 0
      order by physical_only desc
      limit 50
    `);

    const byArtist = (byArtistRows as unknown as Array<{ artist: string; physical_only: number; both: number }>)
      .map(row => ({
        artist: row.artist || 'Unknown',
        physicalOnly: row.physical_only,
        both: row.both,
      }));

    reply.status(200).send({
      physicalOnly: ((physicalOnlyCount as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0),
      both: ((bothCount as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0),
      digitalOnly: ((digitalOnlyCount as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0),
      unmapped: ((unmappedCount as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0),
      byArtist,
    });
  });

  // POST /libraries/:lib/collection-sources/remap — re-run mapping (spec XO-303)
  fastify.post('/libraries/:lib/collection-sources/remap', async (request: FastifyRequest, reply: FastifyReply) => {
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

    const boss = await getBoss();
    await boss.send('collection.sync', { libraryId: lib, remapOnly: true }, {
      singletonKey: `collection-remap:${lib}`,
    });

    reply.status(202).send({ ok: true });
  });
}

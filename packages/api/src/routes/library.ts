import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { libraries, scanRoots, jobRuns, entityTags, releaseGroups, localAlbums } from '@liner/db';
import { getDb } from '../db.js';
import { getBoss } from '../boss.js';
import { sealSecret, computeHint, normalizeGenreMap, effectiveGenres } from '@liner/core';
import {
  createScanRootSchema,
  patchScanRootSchema,
  scanRootSchema,
  librarySchema,
  librarySettingsViewSchema,
  patchLibrarySettingsSchema,
} from '@liner/shared/library';
import { ApiError } from '../middleware/errorHandler.js';

export async function createLibraryRoutes(fastify: FastifyInstance) {
  // Get library settings (spec PLT-4)
  fastify.get('/:libraryId/settings', async (request: FastifyRequest, reply: FastifyReply) => {
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

    const libSettings = lib[0];
    const settings = typeof libSettings?.settings === 'string'
      ? JSON.parse(libSettings.settings)
      : (libSettings?.settings ?? {});

    const contactString = (settings as Record<string, any>)['contactString'] ?? null;
    const discogsTokenHint = (settings as Record<string, any>)['discogsTokenHint'] ?? null;
    const acoustidKeyHint = (settings as Record<string, any>)['acoustidKeyHint'] ?? null;
    const onboardingCompletedAt = (settings as Record<string, any>)['onboardingCompletedAt'] ?? null;
    const genreMapRaw = (settings as Record<string, any>)['genreMap'] ?? null;
    const genreMap = normalizeGenreMap(genreMapRaw);

    reply.status(200).send(
      librarySettingsViewSchema.parse({
        contactString,
        discogsTokenSet: discogsTokenHint !== null,
        discogsTokenHint,
        acoustidKeySet: acoustidKeyHint !== null,
        acoustidKeyHint,
        onboardingCompletedAt,
        genreMap,
      })
    );
  });

  // Update library settings (spec PLT-4)
  fastify.patch('/:libraryId/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const body = patchLibrarySettingsSchema.parse(request.body);

    const db = getDb();
    const appSecret = process.env.APP_SECRET;

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

    // Merge into existing settings
    const libSettings = lib[0];
    const currentSettings = typeof libSettings?.settings === 'string'
      ? JSON.parse(libSettings.settings)
      : (libSettings?.settings ?? {});

    const mergedSettings: Record<string, unknown> = { ...currentSettings };

    if (body.contactString !== undefined) {
      mergedSettings.contactString = body.contactString;
    }

    // Seal credentials before storing (PLT-5)
    if (body.discogsToken !== undefined) {
      if (body.discogsToken === null) {
        delete mergedSettings.discogsToken;
        delete mergedSettings.discogsTokenHint;
      } else {
        // Compute hint from plaintext before sealing
        const hint = computeHint(body.discogsToken);
        mergedSettings.discogsTokenHint = hint;
        if (appSecret) {
          mergedSettings.discogsToken = sealSecret(body.discogsToken, appSecret);
        } else {
          // Fallback: store plaintext (migration will seal later)
          mergedSettings.discogsToken = body.discogsToken;
        }
      }
    }

    if (body.acoustidKey !== undefined) {
      if (body.acoustidKey === null) {
        delete mergedSettings.acoustidKey;
        delete mergedSettings.acoustidKeyHint;
      } else {
        // Compute hint from plaintext before sealing
        const hint = computeHint(body.acoustidKey);
        mergedSettings.acoustidKeyHint = hint;
        if (appSecret) {
          mergedSettings.acoustidKey = sealSecret(body.acoustidKey, appSecret);
        } else {
          // Fallback: store plaintext (migration will seal later)
          mergedSettings.acoustidKey = body.acoustidKey;
        }
      }
    }

    if (body.onboardingCompletedAt !== undefined) {
      mergedSettings.onboardingCompletedAt = body.onboardingCompletedAt;
    }

    if (body.genreMap !== undefined) {
      mergedSettings.genreMap = normalizeGenreMap(body.genreMap);
    }

    await db.update(libraries)
      .set({ settings: sql`${JSON.stringify(mergedSettings)}::jsonb` })
      .where(eq(libraries.id, libraryId));

    // Return the view
    const contactString = (mergedSettings as Record<string, any>)['contactString'] ?? null;
    const discogsTokenHint = (mergedSettings as Record<string, any>)['discogsTokenHint'] ?? null;
    const acoustidKeyHint = (mergedSettings as Record<string, any>)['acoustidKeyHint'] ?? null;
    const onboardingCompletedAt = (mergedSettings as Record<string, any>)['onboardingCompletedAt'] ?? null;
    const genreMap = normalizeGenreMap((mergedSettings as Record<string, any>)['genreMap'] ?? null);

    reply.status(200).send(
      librarySettingsViewSchema.parse({
        contactString,
        discogsTokenSet: discogsTokenHint !== null,
        discogsTokenHint,
        acoustidKeySet: acoustidKeyHint !== null,
        acoustidKeyHint,
        onboardingCompletedAt,
        genreMap,
      })
    );
  });

  // Get genre preview for library (spec XO-310 §6)
  fastify.get('/:libraryId/genres/preview', async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Get the genre map (default if not set)
    const libSettings = lib[0];
    const settings = typeof libSettings?.settings === 'string'
      ? JSON.parse(libSettings.settings)
      : (libSettings?.settings ?? {});
    const genreMapRaw = (settings as Record<string, any>)['genreMap'] ?? null;
    const map = normalizeGenreMap(genreMapRaw);

    // Fetch top 200 raw tags from release groups of this library's local_albums
    const tagRows = await db.execute(sql`
      select et.tag, et.kind, et.source, et.weight
      from entity_tags et
      where et.entity_type = 'release_group'
        and et.entity_id in (
          select distinct release_group_id from local_albums where library_id = ${libraryId} and release_group_id is not null
        )
      order by et.weight desc nulls last, et.tag asc
      limit 200
    `) as unknown as Array<{ tag: string; kind: string; source: string; weight: number | null }>;

    // Compute mappedTo for each tag by running effectiveGenres on a single tag
    const tags = tagRows.map((row) => {
      const rawTag = {
        tag: row.tag,
        kind: row.kind as 'genre' | 'style' | 'tag',
        source: row.source,
        weight: row.weight ? Number(row.weight) : null,
      };
      const effective = effectiveGenres([rawTag], map);
      const mappedTo = effective.genres.length > 0 ? effective.genres[0] : (effective.styles.length > 0 ? effective.styles[0] : null);

      return {
        tag: row.tag,
        kind: row.kind,
        source: row.source,
        count: 1, // Count of occurrences in the result set
        mappedTo,
      };
    });

    // Build histogram of effective genres across all local_albums with release groups
    // Fetch all tags for all release groups in this library (cap at ~20k rows as per spec)
    const histogramRows = await db.execute(sql`
      select et.tag, et.kind, et.source, et.weight, la.id as album_id
      from entity_tags et
      join (
        select distinct release_group_id, id from local_albums where library_id = ${libraryId} and release_group_id is not null
      ) la on la.release_group_id = et.entity_id
      where et.entity_type = 'release_group'
      limit 20000
    `) as unknown as Array<{ tag: string; kind: string; source: string; weight: number | null; album_id: string }>;

    // Group tags by album ID
    const albumTags = new Map<string, Array<{ tag: string; kind: string; source: string; weight: number | null }>>();
    for (const row of histogramRows) {
      if (!albumTags.has(row.album_id)) {
        albumTags.set(row.album_id, []);
      }
      albumTags.get(row.album_id)!.push({
        tag: row.tag,
        kind: row.kind as 'genre' | 'style' | 'tag',
        source: row.source,
        weight: row.weight ? Number(row.weight) : null,
      });
    }

    // Compute effective genres per album and build histogram
    const genreAlbumCounts = new Map<string, number>();
    for (const [, tagsArray] of albumTags.entries()) {
      const typedTags = tagsArray.map((t) => ({
        tag: t.tag,
        kind: t.kind as 'genre' | 'style' | 'tag',
        source: t.source,
        weight: t.weight,
      }));
      const rgEffective = effectiveGenres(typedTags, map);
      for (const genre of rgEffective.genres) {
        genreAlbumCounts.set(genre, (genreAlbumCounts.get(genre) ?? 0) + 1);
      }
    }

    const histogram = Array.from(genreAlbumCounts.entries())
      .map(([genre, albums]) => ({ genre, albums }))
      .sort((a, b) => b.albums - a.albums);

    reply.status(200).send({
      map,
      tags,
      histogram,
    });
  });

  // Enrich Discogs sweep (spec §12.4)
  fastify.post('/:libraryId/enrich-sweep', async (request: FastifyRequest, reply: FastifyReply) => {
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

    const boss = await getBoss();
    await boss.createQueue('enrich.sweep');
    await boss.send('enrich.sweep', { libraryId }, { singletonKey: `enrich-sweep:${libraryId}` });

    reply.status(202).send({ ok: true });
  });

  // Library stats for the dashboard (spec LIB-7 / §14.2)
  fastify.get('/:libraryId/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const db = getDb();
    const lib = await db.select().from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

    const [albumStats] = await db.execute(sql`
      select count(*)::int as albums,
             coalesce(sum(track_count), 0)::int as album_tracks,
             count(*) filter (where state = 'matched')::int as matched,
             count(*) filter (where state = 'needs_review')::int as needs_review,
             count(*) filter (where state = 'pending')::int as pending,
             count(*) filter (where state = 'unidentified')::int as unidentified
      from local_albums where library_id = ${libraryId}`) as unknown as [Record<string, number>];
    const [fileStats] = await db.execute(sql`
      select count(*)::int as files,
             coalesce(sum(size_bytes), 0)::bigint as bytes,
             coalesce(sum(duration_ms), 0)::bigint as duration_ms,
             count(*) filter (where lossless)::int as lossless
      from audio_files where library_id = ${libraryId} and status = 'present'`) as unknown as [Record<string, string | number>];
    // "Reviews written" is one of the four promise counters (spec §14.2)
    const [reviewStats] = await db.execute(sql`
      select count(*) filter (where coalesce(body_md, '') <> '')::int as written,
             count(*) filter (where rating is not null)::int as rated,
             (select count(*)::int from listens where library_id = ${libraryId}) as listens
      from user_reviews where library_id = ${libraryId}`) as unknown as [Record<string, number>];

    reply.send({
      reviews: {
        written: reviewStats?.['written'] ?? 0,
        rated: reviewStats?.['rated'] ?? 0,
        listens: reviewStats?.['listens'] ?? 0,
      },
      albums: albumStats?.['albums'] ?? 0,
      tracks: Number(fileStats?.['files'] ?? 0),
      hours: Math.round(Number(fileStats?.['duration_ms'] ?? 0) / 3600000),
      storageBytes: Number(fileStats?.['bytes'] ?? 0),
      losslessShare: Number(fileStats?.['files'])
        ? Number(fileStats?.['lossless'] ?? 0) / Number(fileStats['files']) : 0,
      states: {
        matched: albumStats?.['matched'] ?? 0,
        needsReview: albumStats?.['needs_review'] ?? 0,
        pending: albumStats?.['pending'] ?? 0,
        unidentified: albumStats?.['unidentified'] ?? 0,
      },
    });
  });

  // Get all libraries for the authenticated user
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const db = getDb();

    const userLibraries = await db
      .select()
      .from(libraries)
      .where(eq(libraries.ownerUserId, request.user.id));

    reply.status(200).send({
      data: userLibraries.map((lib) =>
        librarySchema.parse({
          id: lib.id,
          ownerUserId: lib.ownerUserId,
          name: lib.name,
          settings:
            typeof lib.settings === 'string'
              ? JSON.parse(lib.settings)
              : (lib.settings ?? {}),
          createdAt: lib.createdAt.toISOString(),
          updatedAt: lib.createdAt.toISOString(),
        })
      ),
    });
  });

  // Get scan roots for a library
  fastify.get('/:libraryId/scan-roots', async (request: FastifyRequest, reply: FastifyReply) => {
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

    const roots = await db
      .select()
      .from(scanRoots)
      .where(eq(scanRoots.libraryId, libraryId));

    reply.status(200).send({
      data: roots.map((sr) =>
        scanRootSchema.parse({
          id: sr.id,
          libraryId: sr.libraryId,
          path: sr.path,
          displayName: sr.displayName,
          writable: sr.writable,
          enabled: sr.enabled,
          pollIntervalS: sr.pollIntervalS,
          validationStatus: sr.validationStatus,
          validationMessage: sr.validationMessage,
          validatedAt: sr.validatedAt?.toISOString(),
          probeWritable: sr.probeWritable,
          lastScanAt: sr.lastScanAt?.toISOString(),
          lastStatus: sr.lastStatus,
          createdAt: sr.createdAt.toISOString(),
          updatedAt: sr.createdAt.toISOString(),
        })
      ),
    });
  });

  // Create a new scan root
  fastify.post('/:libraryId/scan-roots', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { libraryId } = request.params as { libraryId: string };
    const body = createScanRootSchema.parse(request.body);

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

    // LIB-1: validation is the worker's job, not the API host
    const scanRootId = uuidv7();
    const root = {
      id: scanRootId,
      libraryId,
      path: body.path,
      displayName: body.displayName,
      writable: body.writable ?? true, // Owner's intent; worker validates actual ability
      enabled: body.enabled ?? true,
      pollIntervalS: body.pollIntervalS ?? 21600,
      validationStatus: 'pending',
      validationMessage: null,
      validatedAt: null,
      probeWritable: null,
      lastScanAt: null as any,
      lastStatus: null,
      createdAt: new Date(),
    };

    await db.insert(scanRoots).values(root);

    // Enqueue validation job
    const boss = await getBoss();
    await boss.createQueue('roots.validate');
    await boss.send('roots.validate', { scanRootId }, { singletonKey: `roots.validate:${scanRootId}` });

    reply.status(201).send(
      scanRootSchema.parse({
        id: root.id,
        libraryId: root.libraryId,
        path: root.path,
        displayName: root.displayName,
        writable: root.writable,
        enabled: root.enabled,
        pollIntervalS: root.pollIntervalS,
        validationStatus: root.validationStatus,
        validationMessage: root.validationMessage,
        validatedAt: root.validatedAt,
        probeWritable: root.probeWritable,
        createdAt: root.createdAt.toISOString(),
        updatedAt: root.createdAt.toISOString(),
      })
    );
  });

  // Update scan root
  fastify.patch(
    '/:libraryId/scan-roots/:scanRootId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, scanRootId } = request.params as {
        libraryId: string;
        scanRootId: string;
      };
      const body = patchScanRootSchema.parse(request.body);

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

      // Verify scan root exists and belongs to library
      const root = await db
        .select()
        .from(scanRoots)
        .where(
          and(eq(scanRoots.id, scanRootId), eq(scanRoots.libraryId, libraryId))
        );

      if (root.length === 0) {
        throw new ApiError(404, 'Not Found', 'Scan root not found');
      }

      // Update
      const updates: Record<string, any> = {};
      if (body.displayName) updates.displayName = body.displayName;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.pollIntervalS) updates.pollIntervalS = body.pollIntervalS;

      await db.update(scanRoots).set(updates).where(eq(scanRoots.id, scanRootId));

      const updated = await db
        .select()
        .from(scanRoots)
        .where(eq(scanRoots.id, scanRootId));

      const sr = updated[0];
      if (!sr) {
        // Invariant: scan root should exist since we just updated it
        throw new ApiError(404, 'Not Found', 'Scan root not found');
      }
      reply.status(200).send(
        scanRootSchema.parse({
          id: sr.id,
          libraryId: sr.libraryId,
          path: sr.path,
          displayName: sr.displayName,
          writable: sr.writable,
          enabled: sr.enabled,
          pollIntervalS: sr.pollIntervalS,
          validationStatus: sr.validationStatus,
          validationMessage: sr.validationMessage,
          validatedAt: sr.validatedAt?.toISOString(),
          probeWritable: sr.probeWritable,
          lastScanAt: sr.lastScanAt?.toISOString(),
          lastStatus: sr.lastStatus,
          createdAt: sr.createdAt.toISOString(),
          updatedAt: sr.createdAt.toISOString(),
        })
      );
    }
  );

  // Delete scan root
  fastify.delete(
    '/:libraryId/scan-roots/:scanRootId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, scanRootId } = request.params as {
        libraryId: string;
        scanRootId: string;
      };

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

      // Verify scan root exists and belongs to library
      const root = await db
        .select()
        .from(scanRoots)
        .where(
          and(eq(scanRoots.id, scanRootId), eq(scanRoots.libraryId, libraryId))
        );

      if (root.length === 0) {
        throw new ApiError(404, 'Not Found', 'Scan root not found');
      }

      await db.delete(scanRoots).where(eq(scanRoots.id, scanRootId));

      reply.status(204).send();
    }
  );

  // Trigger validation for a scan root (re-check path on worker)
  fastify.post(
    '/:libraryId/scan-roots/:scanRootId/validate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, scanRootId } = request.params as {
        libraryId: string;
        scanRootId: string;
      };

      const db = getDb();

      // Verify ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(
          and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
        );

      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      const root = await db
        .select()
        .from(scanRoots)
        .where(
          and(eq(scanRoots.id, scanRootId), eq(scanRoots.libraryId, libraryId))
        );

      if (root.length === 0) {
        throw new ApiError(404, 'Not Found', 'Scan root not found');
      }

      // Enqueue validation job
      const boss = await getBoss();
      await boss.createQueue('roots.validate');
      await boss.send('roots.validate', { scanRootId }, { singletonKey: `roots.validate:${scanRootId}` });

      reply.status(202).send({ ok: true });
    }
  );

  // Trigger scan for a root
  fastify.post(
    '/:libraryId/scan-roots/:scanRootId/scan',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        throw new ApiError(401, 'Unauthorized', 'Authentication required');
      }

      const { libraryId, scanRootId } = request.params as {
        libraryId: string;
        scanRootId: string;
      };

      const db = getDb();

      // Verify ownership
      const lib = await db
        .select()
        .from(libraries)
        .where(
          and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id))
        );

      if (lib.length === 0) {
        throw new ApiError(404, 'Not Found', 'Library not found');
      }

      const root = await db
        .select()
        .from(scanRoots)
        .where(
          and(eq(scanRoots.id, scanRootId), eq(scanRoots.libraryId, libraryId))
        );

      if (root.length === 0) {
        throw new ApiError(404, 'Not Found', 'Scan root not found');
      }

      // LIB-1: check validation status before scanning (spec §24)
      if (root[0]!.validationStatus !== 'ok') {
        throw new ApiError(409, 'Conflict', `Scan root has not been validated by the worker yet (status: ${root[0]!.validationStatus})`);
      }

      // Enqueue scan job
      const jobId = uuidv7();
      const job = {
        id: jobId,
        libraryId,
        pgbossId: null,
        type: 'scan.root',
        subjectType: 'scan_root',
        subjectId: scanRootId,
        state: 'created',
        progress: { done: 0, total: 0 },
        startedAt: null as any,
        finishedAt: null as any,
        error: null,
        createdAt: new Date(),
      };

      await db.insert(jobRuns).values(job);

      const boss = await getBoss();
      await boss.createQueue('scan.root');
      await boss.send('scan.root', { scanRootId }, { singletonKey: `scan:${scanRootId}` });

      reply.status(202).send({
        id: jobId,
        type: 'scan.root',
        state: 'created',
        createdAt: job.createdAt.toISOString(),
      });
    }
  );
}

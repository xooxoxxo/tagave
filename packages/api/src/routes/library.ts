import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { libraries, scanRoots, jobRuns } from '@liner/db';
import { getDb } from '../db.js';
import PgBoss from 'pg-boss';
import {
  createScanRootSchema,
  patchScanRootSchema,
  scanRootSchema,
  librarySchema,
  librarySettingsViewSchema,
  patchLibrarySettingsSchema,
} from '@liner/shared/library';
import { ApiError } from '../middleware/errorHandler.js';

let bossSingleton: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (!bossSingleton) {
    bossSingleton = new PgBoss(process.env.DATABASE_URL!);
    await bossSingleton.start();
  }
  return bossSingleton;
}

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
    const discogsToken = (settings as Record<string, any>)['discogsToken'];
    const discogsTokenHint = discogsToken && typeof discogsToken === 'string'
      ? discogsToken.slice(-4)
      : null;

    reply.status(200).send(
      librarySettingsViewSchema.parse({
        contactString,
        discogsTokenSet: !!discogsToken,
        discogsTokenHint,
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

    // Build the update object
    const updates: Record<string, unknown> = {};
    if (body.contactString !== undefined) {
      updates.contactString = body.contactString;
    }
    if (body.discogsToken !== undefined) {
      updates.discogsToken = body.discogsToken;
    }

    // Merge into existing settings using SQL to handle jsonb operations
    const libSettings = lib[0];
    const currentSettings = typeof libSettings?.settings === 'string'
      ? JSON.parse(libSettings.settings)
      : (libSettings?.settings ?? {});

    const mergedSettings: Record<string, unknown> = { ...currentSettings };

    if (body.contactString !== undefined) {
      mergedSettings.contactString = body.contactString;
    }
    if (body.discogsToken !== undefined) {
      if (body.discogsToken === null) {
        // Delete the key
        delete mergedSettings.discogsToken;
      } else {
        mergedSettings.discogsToken = body.discogsToken;
      }
    }

    await db.update(libraries)
      .set({ settings: mergedSettings })
      .where(eq(libraries.id, libraryId));

    // Return the view
    const contactString = (mergedSettings as Record<string, any>)['contactString'] ?? null;
    const discogsToken = (mergedSettings as Record<string, any>)['discogsToken'];
    const discogsTokenHint = discogsToken && typeof discogsToken === 'string'
      ? discogsToken.slice(-4)
      : null;

    reply.status(200).send(
      librarySettingsViewSchema.parse({
        contactString,
        discogsTokenSet: !!discogsToken,
        discogsTokenHint,
      })
    );
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

    reply.send({
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

  // Artists derived from local clusters (M0 grade; canonical artists in M1)
  fastify.get('/:libraryId/artists', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) throw new ApiError(401, 'Unauthorized', 'Authentication required');
    const { libraryId } = request.params as { libraryId: string };
    const { search = '', limit = '100', offset = '0' } = request.query as Record<string, string>;
    const db = getDb();
    const lib = await db.select().from(libraries)
      .where(and(eq(libraries.id, libraryId), eq(libraries.ownerUserId, request.user.id)));
    if (lib.length === 0) throw new ApiError(404, 'Not Found', 'Library not found');

    const limitN = Math.min(parseInt(limit, 10) || 100, 500);
    const offsetN = parseInt(offset, 10) || 0;
    const rows = await db.execute(sql`
      select artist_guess as name,
             count(*)::int as album_count,
             coalesce(sum(track_count), 0)::int as track_count,
             min(year_guess)::int as year_from,
             max(year_guess)::int as year_to
      from local_albums
      where library_id = ${libraryId}
        and artist_guess is not null
        ${search ? sql`and artist_guess ilike ${'%' + search + '%'}` : sql``}
      group by artist_guess
      order by lower(artist_guess)
      limit ${limitN + 1} offset ${offsetN}`) as unknown as Record<string, unknown>[];

    const items = rows.slice(0, limitN).map((r) => ({
      name: r['name'],
      albumCount: r['album_count'],
      trackCount: r['track_count'],
      yearFrom: r['year_from'],
      yearTo: r['year_to'],
    }));
    reply.send({
      items,
      nextCursor: rows.length > limitN ? String(offsetN + limitN) : null,
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

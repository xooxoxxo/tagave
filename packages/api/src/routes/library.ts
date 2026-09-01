import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import path from 'path';
import fs from 'fs/promises';
import { makeDb, libraries, scanRoots, jobRuns } from '@liner/db';
import {
  createScanRootSchema,
  patchScanRootSchema,
  scanRootSchema,
  librarySchema,
} from '@liner/shared/library';
import { ApiError } from '../middleware/errorHandler.js';

export async function createLibraryRoutes(fastify: FastifyInstance) {
  // Get all libraries for the authenticated user
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required');
    }

    const { db } = await makeDb(process.env.DATABASE_URL!);

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
          settings: lib.settings ? JSON.parse(lib.settings as string) : {},
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
    const { db } = await makeDb(process.env.DATABASE_URL!);

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

    const { db } = await makeDb(process.env.DATABASE_URL!);

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

    // Validate path exists and is readable
    let isReadOnly = false;
    try {
      const pathStats = await fs.stat(body.path);
      if (!pathStats.isDirectory()) {
        throw new ApiError(400, 'Bad Request', 'Scan root path must be a directory');
      }

      // Check if path is writable
      try {
        await fs.access(body.path, fs.constants.W_OK);
      } catch {
        isReadOnly = true;
      }
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        throw new ApiError(400, 'Bad Request', `Path does not exist: ${body.path}`);
      }
      if ((err as any).code === 'EACCES') {
        throw new ApiError(400, 'Bad Request', `Path is not readable: ${body.path}`);
      }
      throw err;
    }

    const scanRootId = uuidv7();
    const root = {
      id: scanRootId,
      libraryId,
      path: body.path,
      displayName: body.displayName,
      writable: !isReadOnly,
      enabled: true,
      pollIntervalS: body.pollIntervalS || 21600,
      lastScanAt: null as any,
      lastStatus: null,
      createdAt: new Date(),
    };

    await db.insert(scanRoots).values(root);

    reply.status(201).send(
      scanRootSchema.parse({
        id: root.id,
        libraryId: root.libraryId,
        path: root.path,
        displayName: root.displayName,
        writable: root.writable,
        enabled: root.enabled,
        pollIntervalS: root.pollIntervalS,
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

      const { db } = await makeDb(process.env.DATABASE_URL!);

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

      const { db } = await makeDb(process.env.DATABASE_URL!);

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

      const { db } = await makeDb(process.env.DATABASE_URL!);

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
        progress: JSON.stringify({ done: 0, total: 0 }),
        startedAt: null as any,
        finishedAt: null as any,
        error: null,
        createdAt: new Date(),
      };

      await db.insert(jobRuns).values(job);

      reply.status(202).send({
        id: jobId,
        type: 'scan.root',
        state: 'created',
        createdAt: job.createdAt.toISOString(),
      });
    }
  );
}

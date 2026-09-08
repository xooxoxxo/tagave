import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runDoctor } from '@liner/doctor';
import { readBuildInfo } from '@liner/core';
import { getDb } from '../db.js';

export async function createHealthRoutes(fastify: FastifyInstance) {
  // Health check endpoint
  fastify.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return reply.status(503).send({
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'error',
        error: 'DATABASE_URL not set',
      });
    }

    try {
      // Local checks only: a health probe must never spend MusicBrainz /
      // Discogs budget (uptime monitors poll this every few seconds).
      const result = await runDoctor({
        databaseUrl,
        ...(process.env.CACHE_DIR ? { cacheDir: process.env.CACHE_DIR } : {}),
        expectWorkers: 2,
        offline: true,
      });

      // Extract individual check results
      const checkMap = new Map(result.checks.map((c) => [c.id, c]));

      const database = checkMap.get('database')?.status === 'pass' ? 'ok' : 'error';
      const migrations = checkMap.get('migrations')?.status === 'pass' ? 'ok' : 'error';
      const cacheDir = checkMap.get('cacheDir')?.status === 'pass' ? 'ok' : 'error';
      const workerHeartbeat =
        checkMap.get('workerHeartbeat')?.status === 'pass'
          ? 'ok'
          : checkMap.get('workerHeartbeat')?.status === 'warn'
            ? 'warn'
            : 'error';

      const health: any = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database,
        cacheDir,
        workerHeartbeat,
        checks: result.checks.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          detail: c.detail,
        })),
      };

      // Fail (503) if database or migrations are down
      if (database === 'error' || migrations === 'error') {
        return reply.status(503).send(health);
      }

      reply.status(200).send(health);
    } catch (err) {
      return reply.status(503).send({
        status: 'error',
        timestamp: new Date().toISOString(),
        database: 'error',
        error: (err as any).message,
      });
    }
  });

  // Version endpoint: build identity from the image's build args, the
  // DEPLOYED file or git (XO-313).
  fastify.get('/version', async (request: FastifyRequest, reply: FastifyReply) => {
    const build = readBuildInfo();
    reply.status(200).send({
      version: build.version,
      sha: build.sha,
      builtAt: build.builtAt,
      buildSource: build.source,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
    });
  });
}

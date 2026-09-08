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

      // Extract individual check results. A warn (e.g. a migration the
      // workers applied that this app build does not carry yet, or a worker
      // short) is reported as such; only a failed database or migration
      // ledger makes the endpoint 503.
      const checkMap = new Map(result.checks.map((c) => [c.id, c]));
      const level = (id: string): 'ok' | 'warn' | 'error' => {
        const status = checkMap.get(id)?.status;
        return status === 'pass' ? 'ok' : status === 'warn' ? 'warn' : 'error';
      };

      const database = level('database');
      const migrations = level('migrations');
      const cacheDir = level('cacheDir');
      const workerHeartbeat = level('workerHeartbeat');
      const down = database === 'error' || migrations === 'error';

      const health: any = {
        status: down ? 'error' : 'ok',
        timestamp: new Date().toISOString(),
        database,
        migrations,
        cacheDir,
        workerHeartbeat,
        checks: result.checks.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          detail: c.detail,
        })),
      };

      reply.status(down ? 503 : 200).send(health);
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

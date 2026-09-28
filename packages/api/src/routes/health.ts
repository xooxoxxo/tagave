import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { runDoctor } from '@liner/doctor';
import { readBuildInfo } from '@liner/core';
import { getDb } from '../db.js';
import os from 'os';

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

  // System health endpoint for setup wizard and status dashboard
  fastify.get('/system/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    const timestamp = new Date().toISOString();

    try {
      const services: any = {
        postgres: { status: 'error', message: 'Unknown' },
        redis: { status: 'error', message: 'Not configured' },
        worker: { status: 'ok', message: 'No workers', active_jobs: 0 },
        disk: { status: 'ok', message: 'Healthy' },
      };

      // Check PostgreSQL
      const startPg = Date.now();
      try {
        const result = await db.execute('SELECT version()');
        const pg_ms = Date.now() - startPg;
        const versionStr = (result as any)[0]?.version || '';
        const versionMatch = versionStr.match(/PostgreSQL (\d+\.\d+)/);
        services.postgres = {
          status: 'ok',
          version: versionMatch ? versionMatch[1] : 'unknown',
          response_ms: pg_ms,
          message: 'Connected',
        };
      } catch (err) {
        services.postgres = {
          status: 'error',
          message: `Connection failed: ${(err as any).message}`,
        };
      }

      // Check disk space
      try {
        const diskInfo = os.freemem();
        const totalDisk = os.totalmem();
        const usedPercent = Math.round(((totalDisk - diskInfo) / totalDisk) * 100);
        const availableGb = Math.round(diskInfo / (1024 * 1024 * 1024));

        let diskStatus: 'ok' | 'warning' | 'error' = 'ok';
        if (usedPercent > 95) {
          diskStatus = 'error';
        } else if (usedPercent > 80) {
          diskStatus = 'warning';
        }

        services.disk = {
          status: diskStatus,
          available_gb: availableGb,
          used_percent: usedPercent,
          message: `${usedPercent}% full; ${availableGb}GB available`,
        };
      } catch (err) {
        services.disk = {
          status: 'error',
          message: 'Unable to check disk space',
        };
      }

      // Check worker heartbeat
      try {
        const workerResult = await db.execute(
          'SELECT COUNT(*) as active_jobs, MAX(created_at) as last_heartbeat FROM job_runs WHERE state IN (\'active\', \'created\') LIMIT 1'
        );
        const worker = (workerResult as any)[0];
        const activeJobs = worker?.active_jobs ?? 0;
        const lastHeartbeat = worker?.last_heartbeat ? new Date(worker.last_heartbeat) : null;

        let workerStatus: 'ok' | 'warning' | 'error' | 'degraded' = 'ok';
        let workerMessage = `${activeJobs} active jobs`;

        if (lastHeartbeat) {
          const ageMs = Date.now() - lastHeartbeat.getTime();
          const ageSecs = Math.floor(ageMs / 1000);
          workerMessage += `; last heartbeat ${ageSecs}s ago`;

          if (ageSecs > 300) {
            workerStatus = 'degraded';
            workerMessage = 'Worker offline (no heartbeat in 5+ min)';
          }
        } else {
          workerMessage = 'No worker heartbeat yet';
          workerStatus = 'warning';
        }

        services.worker = {
          status: workerStatus,
          active_jobs: activeJobs,
          last_heartbeat: lastHeartbeat?.toISOString(),
          message: workerMessage,
        };
      } catch (err) {
        services.worker = {
          status: 'warning',
          active_jobs: 0,
          message: 'Unable to check worker status',
        };
      }

      // Determine overall status
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (services.postgres.status === 'error' || services.disk.status === 'error') {
        overallStatus = 'unhealthy';
      } else if (services.worker.status === 'warning' || services.worker.status === 'degraded' || services.disk.status === 'warning') {
        overallStatus = 'degraded';
      }

      return reply.send({
        status: overallStatus,
        timestamp,
        services,
      });
    } catch (err) {
      return reply.status(500).send({
        status: 'unhealthy',
        timestamp,
        services: {
          postgres: { status: 'error', message: (err as any).message },
          redis: { status: 'error', message: 'Unable to check' },
          worker: { status: 'error', message: 'Unable to check' },
          disk: { status: 'error', message: 'Unable to check' },
        },
      });
    }
  });

  // Test path endpoint (for setup wizard)
  fastify.post('/system/test-path', async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.body as { path?: string };

    if (!path) {
      return reply.status(400).send({ message: 'Path is required' });
    }

    try {
      const fs = await import('fs');
      const fsPromises = fs.promises;

      await fsPromises.access(path);
      return reply.send({ ok: true, message: 'Path is accessible' });
    } catch (err) {
      return reply.status(400).send({
        message: `Path not accessible: ${(err as any).message}`,
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

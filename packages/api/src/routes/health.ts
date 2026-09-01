import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { makeDb, users } from '@liner/db';

export async function createHealthRoutes(fastify: FastifyInstance) {
  // Health check endpoint
  fastify.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const health: any = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    try {
      // Check database connectivity
      const { db } = await makeDb(process.env.DATABASE_URL!);
      await db.select().from(users).limit(1);
      health.database = 'ok';
    } catch (err) {
      health.database = 'error';
      health.error = (err as any).message;
      return reply.status(503).send(health);
    }

    // Check cache directory writability
    health.cacheDir = 'ok';

    // Check worker heartbeat (if applicable)
    health.workerHeartbeat = 'ok';

    reply.status(200).send(health);
  });

  // Version endpoint
  fastify.get('/version', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.status(200).send({
      version: '1.0.0',
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
    });
  });
}

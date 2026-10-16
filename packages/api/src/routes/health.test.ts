/**
 * The public /health when the doctor itself throws: a fixed message for the
 * caller, the real error in the server log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('@tagave/doctor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tagave/doctor')>()),
  runDoctor: vi.fn(async () => { throw new Error("EACCES: permission denied, statfs '/srv/secret/backups'"); }),
}));
vi.mock('../db.js', () => ({ getDb: () => ({}) }));

describe('GET /health when the checks throw', () => {
  let app: FastifyInstance;
  const logged: unknown[] = [];
  const saved = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgres://u:p@postgres:5432/tagave';
    const { createHealthRoutes } = await import('./health.js');
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      const error = request.log.error.bind(request.log);
      request.log.error = ((obj: unknown, ...rest: unknown[]) => { logged.push(obj); return (error as (...a: unknown[]) => void)(obj, ...rest); }) as typeof request.log.error;
    });
    await app.register(createHealthRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('answers 503 with a fixed message and logs what failed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', database: 'error', error: 'Health check failed' });
    expect(res.body).not.toContain('/srv/secret');
    expect(logged).toEqual([expect.objectContaining({ err: expect.objectContaining({ message: expect.stringContaining('/srv/secret/backups') }) })]);
  });
});

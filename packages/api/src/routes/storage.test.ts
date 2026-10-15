/**
 * GET /storage when it cannot measure: each failure says what failed. The
 * page used to show "Only the owner can see this page" for all of them,
 * also while the database was down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeDb } from '@tagave/db';
import { PROBLEM_TYPES } from '@tagave/shared';
import { databaseUnreachable } from '../lib/databaseUnreachable.js';

const usage = vi.hoisted(() => ({ database: vi.fn(), folder: null as null | ((dir: string) => Promise<unknown>) }));
vi.mock('../db.js', () => ({ getDb: () => ({}) }));
vi.mock('../lib/storageUsage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/storageUsage.js')>();
  return {
    ...real,
    databaseUsage: usage.database,
    folderUsage: (dir: string, opts?: { skip?: string }) => (usage.folder ? usage.folder(dir) : real.folderUsage(dir, opts)),
  };
});

/** What postgres.js rejects a query with when the server is not there: a Node net error it marks with the query. */
const connRefused = () => {
  const e = Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED', errno: -111, address: '172.18.0.2', port: 5432 });
  return Object.defineProperties(e, { query: { value: 'select 1' }, parameters: { value: [] } });
};
/** drizzle's DrizzleQueryError around it. */
const drizzle = (cause: unknown) => Object.assign(new Error('Failed query: select ...'), { query: 'select ...', params: [], cause });
/** undici's fetch() to a provider whose host does not resolve. */
const fetchFailed = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND musicbrainz.org'), { code: 'ENOTFOUND', hostname: 'musicbrainz.org' }) });
const DB_URL = 'postgres://tagave:x@postgres:5432/tagave';

describe('databaseUnreachable', () => {
  it('knows the network codes of errors that came through the driver, also wrapped', () => {
    expect(databaseUnreachable(connRefused(), DB_URL)).toBe('it refuses connections (ECONNREFUSED)');
    expect(databaseUnreachable(new Error('outer', { cause: connRefused() }), DB_URL)).toBe('it refuses connections (ECONNREFUSED)');
    const bare = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(databaseUnreachable(drizzle(bare), DB_URL)).toBe('it refuses connections (ECONNREFUSED)');
    expect(databaseUnreachable(drizzle(new AggregateError([bare], '')), DB_URL)).toBe('it refuses connections (ECONNREFUSED)');
    expect(databaseUnreachable(Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' }), DB_URL)).toBe('it does not answer (CONNECT_TIMEOUT)');
  });

  it('knows a bare network error by the database address in DATABASE_URL', () => {
    // a container name resolves to an address, so the port decides
    expect(databaseUnreachable(Object.assign(new Error('x'), { code: 'ECONNREFUSED', address: '172.18.0.2', port: 5432 }), DB_URL)).toBe('it refuses connections (ECONNREFUSED)');
    expect(databaseUnreachable(Object.assign(new Error('x'), { code: 'ENOTFOUND', hostname: 'postgres' }), DB_URL)).toBe('its host name does not resolve (ENOTFOUND)');
    expect(databaseUnreachable(Object.assign(new Error('x'), { code: 'ECONNREFUSED', address: '10.0.0.9', port: 5432 }), 'postgres://u:x@10.0.0.5:5432/d')).toBeNull();
    expect(databaseUnreachable(Object.assign(new Error('x'), { code: 'ECONNREFUSED', address: '10.0.0.9', port: 443 }), DB_URL)).toBeNull();
  });

  it('never blames the database for another service that is down', () => {
    expect(databaseUnreachable(fetchFailed(), DB_URL)).toBeNull();
    expect(databaseUnreachable(fetchFailed(), undefined)).toBeNull();
    expect(databaseUnreachable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), undefined)).toBeNull();
  });

  it('knows the SQLSTATEs of a server that cannot serve', () => {
    expect(databaseUnreachable(Object.assign(new Error('the database system is starting up'), { code: '57P03' }))).toBe('it is starting up or recovering (57P03)');
    expect(databaseUnreachable(Object.assign(new Error('could not extend file'), { code: '53100' }))).toBe('its disk is full (53100)');
    expect(databaseUnreachable(Object.assign(new Error('x'), { code: '08006' }))).toBe('the connection failed (08006)');
  });

  it('leaves query errors and others alone', () => {
    expect(databaseUnreachable(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBeNull();
    expect(databaseUnreachable(Object.assign(new Error('permission denied'), { code: 'EACCES' }))).toBeNull();
    expect(databaseUnreachable(null)).toBeNull();
    expect(databaseUnreachable('boom')).toBeNull();
  });

  it('recognises what postgres.js and drizzle really throw for a closed port', async () => {
    const { db, client } = await makeDb('postgres://nobody:x@127.0.0.1:1/none?connect_timeout=2');
    try {
      const err = await db.execute('select 1').then(() => null, (e: unknown) => e);
      expect(databaseUnreachable(err)).toMatch(/\((ECONNREFUSED|CONNECT_TIMEOUT)\)$/);
    } finally {
      await client.end({ timeout: 1 });
    }
  });
});

describe('GET /storage errors', () => {
  let app: FastifyInstance;
  let dir: string;
  const as = (role: string) => ({ 'x-test-user': 'u1', 'x-test-role': role });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-storage-err-'));
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createStorageRoutes } = await import('./storage.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-session-fails']) throw drizzle(connRefused());
      if (request.headers['x-test-provider-fails']) throw fetchFailed();
      if (request.headers['x-test-bad-request']) throw Object.assign(drizzle(connRefused()), { statusCode: 400 });
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@test.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createStorageRoutes, { prefix: '/api/v1', cacheDir: join(dir, 'cache'), backupDir: join(dir, 'backups') });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    usage.database.mockReset();
    usage.database.mockResolvedValue({ totalBytes: 10, categories: [] });
    usage.folder = null;
  });

  it('answers 503 "Database unreachable" when the database is down', async () => {
    usage.database.mockRejectedValue(drizzle(connRefused()));
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      type: PROBLEM_TYPES.databaseUnreachable,
      title: 'Database unreachable',
      status: 503,
      step: 'database',
    });
    expect(res.json().detail).toMatch(/^The database cannot be reached: it refuses connections \(ECONNREFUSED\)\. Check that the postgres container runs/);
  });

  it('answers 503 too when the session lookup before the route finds the database down', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: { ...as('owner'), 'x-test-session-fails': '1' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.databaseUnreachable, title: 'Database unreachable', status: 503, instance: expect.any(String) });
  });

  it('leaves other errors to the handler as before: a provider outage stays 500, a 400 stays 400', async () => {
    const provider = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: { ...as('owner'), 'x-test-provider-fails': '1' } });
    expect(provider.statusCode).toBe(500);
    expect(provider.json()).toMatchObject({ title: 'Internal Server Error', detail: 'An unexpected error occurred' });
    const bad = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: { ...as('owner'), 'x-test-bad-request': '1' } });
    expect(bad.statusCode).toBe(400);
  });

  it('calls a provider-style failure in the database step a measurement failure', async () => {
    usage.database.mockRejectedValue(fetchFailed());
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.storageMeasurementFailed, step: 'database' });
  });

  it('never blames the database for a folder that times out (NFS)', async () => {
    usage.folder = async (d) => {
      if (d.endsWith('backups')) throw drizzle(Object.assign(new Error('ETIMEDOUT: connection timed out, scandir'), { code: 'ETIMEDOUT' }));
      return { bytes: 0, files: 0, exists: false, truncated: false, error: null };
    };
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.storageMeasurementFailed, step: 'backups' });
  });

  it('answers 500 naming the step for any other failure', async () => {
    usage.database.mockRejectedValue(Object.assign(new Error('relation "albums" does not exist'), { code: '42P01' }));
    const db = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(db.statusCode).toBe(500);
    expect(db.json()).toMatchObject({
      type: PROBLEM_TYPES.storageMeasurementFailed,
      title: 'Measurement failed',
      step: 'database',
      detail: 'Measuring the database failed: relation "albums" does not exist',
    });

    usage.database.mockResolvedValue({ totalBytes: 10, categories: [] });
    usage.folder = async (d) => {
      if (d.endsWith('backups')) throw new Error('EIO: i/o error, scandir');
      return { bytes: 0, files: 0, exists: false, truncated: false, error: null };
    };
    const folder = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(folder.statusCode).toBe(500);
    expect(folder.json()).toMatchObject({ step: 'backups', detail: `Measuring the backups folder (${join(dir, 'backups')}) failed: EIO: i/o error, scandir` });
  });

  it('keeps 401 and 403 for who asks, without measuring', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/storage' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('viewer') });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ title: 'Forbidden', detail: 'Only the owner can see storage' });
    expect(usage.database).not.toHaveBeenCalled();
  });

  it('still answers 200 when everything measures', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: as('owner') });
    expect(res.statusCode).toBe(200);
    expect(res.json().folders.map((f: { key: string }) => f.key)).toEqual(['cache', 'backups']);
  });
});

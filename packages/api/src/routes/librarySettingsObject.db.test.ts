/**
 * libraries.settings is always a jsonb object, never a jsonb string holding
 * one (SQL `->>`, `?` and jsonb_set see no keys in a string, so doctor reseal
 * skipped such rows and the player purge missed a served library).
 *
 * Every settings writer binds its JSON as text and casts it
 * (`${JSON.stringify(x)}::text::jsonb`), so the stored value does not depend
 * on how the client serializes a jsonb parameter. The API's shared client
 * passes jsonb parameters through as they are (drizzle's postgres-js driver
 * installs that serializer); a plain postgres.js client JSON.stringifies them,
 * which turned an already-stringified object into a string. Each writer runs
 * here on both, and migration 0051 unwraps the strings already stored.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { MIGRATIONS_DIR } from '@tagave/db';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';
import { close, fakeNavidrome } from '../testkit/playerFakes.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));
vi.mock('@tagave/core/scrobble', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tagave/core/scrobble')>()),
  lastfmCheckApp: async () => ({ ok: true }),
}));

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'nav-secret-pw';
const SECRET = 'test-app-secret-'.padEnd(48, 'x');
const MIGRATION = '0051_library_settings_object.sql';

describe.skipIf(!url)('libraries.settings stays a jsonb object (integration)', () => {
  let admin: postgres.Sql;
  const dbs: string[] = [];

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
  });
  afterAll(async () => {
    for (const name of dbs) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  describe('migration 0051', () => {
    let sql: postgres.Sql;
    let dbUrl: string;
    const ownerId = randomUUID();
    const ids = { bound: randomUUID(), wrapped: randomUUID(), twice: randomUUID(), object: randomUUID(), notObject: randomUUID(), empty: randomUUID() };
    const settings = { contactString: 'me@example.com', discogsToken: 'enc:v1:abc', updates: { enabled: false } };

    beforeAll(async () => {
      const db = await createScratchDb(url!, admin);
      dbs.push(db.name);
      dbUrl = db.url;
      await migrateUpTo(db.url, '0051');
      sql = postgres(db.url, { max: 1, onnotice: () => undefined });
      await sql`insert into users (id, email, password_hash) values (${ownerId}, 'o@example.com', 'x')`;
      // The bug as it happened: a plain postgres.js client JSON.stringifies a
      // jsonb parameter, so an already-stringified object lands as a string.
      await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.bound}, ${ownerId}, 'as a plain client bound it', ${JSON.stringify(settings)}::jsonb)`;
      const lib = (id: string, name: string, value: string) =>
        sql`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${ownerId}, ${name}, ${value}::text::jsonb)`;
      await lib(ids.wrapped, 'wrapped', JSON.stringify(JSON.stringify(settings)));
      await lib(ids.twice, 'twice', JSON.stringify(JSON.stringify(JSON.stringify(settings))));
      await lib(ids.object, 'object', JSON.stringify(settings));
      await lib(ids.notObject, 'not an object', JSON.stringify('not json at all'));
      await lib(ids.empty, 'empty', '{}');
      const before = await sql`select name, jsonb_typeof(settings) as t from libraries order by name`;
      expect(before.map((r) => r['t'])).toEqual(['string', 'object', 'string', 'object', 'string', 'string']);
    });
    afterAll(async () => { await sql?.end({ timeout: 2 }); });

    it('unwraps a string into the object it holds, leaves objects and other strings', async () => {
      const objectBefore = await sql`select settings::text as s from libraries where id = ${ids.object}`;
      expect(await migrateAll(dbUrl)).toEqual([MIGRATION]);
      const rows = await sql<{ id: string; t: string; c: string | null; s: unknown }[]>`
        select id, jsonb_typeof(settings) as t, settings->>'contactString' as c, settings as s from libraries`;
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      for (const id of [ids.bound, ids.wrapped, ids.twice]) {
        expect(by[id]).toMatchObject({ t: 'object', c: 'me@example.com', s: settings });
      }
      expect(by[ids.object]).toMatchObject({ t: 'object', s: settings });
      expect(await sql`select settings::text as s from libraries where id = ${ids.object}`).toEqual(objectBefore);
      expect(by[ids.empty]).toMatchObject({ t: 'object', s: {} });
      // Nothing to recover from a string that holds no object: left as it was.
      expect(by[ids.notObject]).toMatchObject({ t: 'string', s: 'not json at all' });
    });

    it('is a no-op when run again', async () => {
      const before = await sql`select id, settings::text as s from libraries order by id`;
      await sql.unsafe(await readFile(join(MIGRATIONS_DIR, MIGRATION), 'utf-8'));
      expect(await sql`select id, settings::text as s from libraries order by id`).toEqual(before);
    });
  });

  describe('every settings writer', () => {
    let app: FastifyInstance;
    let client: postgres.Sql;
    let raw: postgres.Sql;
    let base = '';
    const nav = fakeNavidrome(PASSWORD);
    const ownerId = randomUUID();
    const libraryId = randomUUID();
    const rootId = randomUUID();
    const owner = { 'x-test-user': ownerId, 'x-test-role': 'owner' };
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['APP_SECRET', 'TAGAVE_PLAYER_URL', 'TAGAVE_PLAYER_USER', 'TAGAVE_PLAYER_PASSWORD'] as const;
    /** The serializers the shared client has for json (114) and jsonb (3802). */
    let passThrough: Record<number, unknown> = {};

    /**
     * 'shared': the API's client as it is. 'plain': the same client with
     * postgres.js's own json serializers, like a client drizzle never wrapped.
     */
    const jsonbParams = (mode: 'shared' | 'plain') => {
      const s = client.options.serializers as Record<number, unknown>;
      for (const oid of [114, 3802]) s[oid] = mode === 'shared' ? passThrough[oid] : (x: unknown) => JSON.stringify(x);
    };
    const typeOf = async () => {
      const [row] = await raw<{ t: string }[]>`select jsonb_typeof(settings) as t from libraries where id = ${libraryId}`;
      return row?.t;
    };
    const keyOf = async (key: string) => {
      const [row] = await raw<{ v: string | null }[]>`select settings->>${key} as v from libraries where id = ${libraryId}`;
      return row?.v ?? null;
    };
    const inject = async (method: 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object) => {
      const res = await app.inject({ method, url: `/api/v1${path}`, headers: owner, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${path}: ${res.body}`).toBeLessThan(300);
      return res;
    };

    beforeAll(async () => {
      for (const k of envKeys) savedEnv[k] = process.env[k];
      process.env['APP_SECRET'] = SECRET;
      for (const k of envKeys.slice(1)) delete process.env[k];
      await new Promise<void>((r) => nav.server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(nav.server.address() as AddressInfo).port}`;

      const db = await createScratchDb(url!, admin);
      dbs.push(db.name);
      await migrateAll(db.url);
      raw = postgres(db.url, { max: 1, onnotice: () => undefined });
      const { initDb } = await import('../db.js');
      client = (await initDb(db.url)).client;
      const s = client.options.serializers as Record<number, unknown>;
      passThrough = { 114: s[114], 3802: s[3802] };

      await raw`insert into users (id, email, password_hash) values (${ownerId}, ${`o-${ownerId}@t.com`}, 'x')`;
      await raw`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Home', '{}'::jsonb)`;
      await raw`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok')`;

      const { errorHandler } = await import('../middleware/errorHandler.js');
      const { createPlayerRoutes } = await import('./player.js');
      const { createPlayerListeningRoutes } = await import('./playerListening.js');
      const { createUpdateRoutes } = await import('./updates.js');
      const { createLibraryRoutes } = await import('./library.js');
      app = Fastify({ logger: false });
      await errorHandler(app);
      app.addHook('preHandler', async (request) => {
        const id = request.headers['x-test-user'];
        request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
      });
      await app.register(createPlayerRoutes, { prefix: '/api/v1' });
      await app.register(createPlayerListeningRoutes, { prefix: '/api/v1' });
      await app.register(createUpdateRoutes, { prefix: '/api/v1' });
      await app.register(createLibraryRoutes, { prefix: '/api/v1/libraries' });
      await app.ready();
    });

    afterAll(async () => {
      if (Object.keys(passThrough).length) jsonbParams('shared');
      await app?.close();
      await close(nav.server).catch(() => undefined);
      await raw?.end({ timeout: 2 });
      await client?.end({ timeout: 2 });
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
      }
    });

    /** Each writer, then what it must have left readable by SQL. */
    const writers: Array<[string, () => Promise<void>, () => Promise<void>]> = [
      ['PATCH /libraries/:id/settings (system keys, setup checklist, tag policy)', async () => {
        await inject('PATCH', `/libraries/${libraryId}/settings`, {
          contactString: 'me@example.com', discogsToken: 'discogs-token-1234', setupChecklistDismissedAt: '2026-10-20T10:00:00.000Z', tagWritesEnabled: true,
        });
      }, async () => {
        expect(await keyOf('contactString')).toBe('me@example.com');
        expect(await keyOf('discogsToken')).toMatch(/^enc:/);
        expect(await keyOf('setupChecklistDismissedAt')).toBe('2026-10-20T10:00:00.000Z');
      }],
      ['PATCH /libraries/:id/scan-roots/:rootId (folder link)', async () => {
        await inject('PATCH', `/libraries/${libraryId}/scan-roots/${rootId}`, { folderLink: 'smb://nas/music' });
      }, async () => {
        expect(await raw`select settings->'folderLinks' ? ${rootId} as ok from libraries where id = ${libraryId}`).toEqual([{ ok: true }]);
      }],
      ['boot seal of plaintext credentials (index.ts)', async () => {
        await raw`update libraries set settings = settings || '{"acoustidKey":"plain-acoustid-key"}'::jsonb where id = ${libraryId}`;
        const { sealPlaintextLibraryCredentials } = await import('../lib/bootSeal.js');
        expect(await sealPlaintextLibraryCredentials(client, SECRET)).toBe(1);
      }, async () => {
        expect(await keyOf('acoustidKey')).toMatch(/^enc:/);
      }],
      ['PUT /libraries/:id/player/server', async () => {
        await inject('PUT', `/libraries/${libraryId}/player/server`, { url: base, username: 'admin', password: PASSWORD });
      }, async () => {
        expect(await keyOf('playerUrl')).toBe(base);
        expect(await keyOf('playerPassword')).toMatch(/^enc:/);
      }],
      ['player scan status (jsonb_set playerLastScan)', async () => {
        const { requestPlayerScan, runPlayerScan, clearCapabilityCache } = await import('../lib/player.js');
        clearCapabilityCache();
        await requestPlayerScan(client, null, libraryId, ['']);
        expect(await runPlayerScan(client, libraryId)).toBe('started');
      }, async () => {
        expect(await raw`select jsonb_typeof(settings->'playerLastScan') as t, settings->'playerLastScan'->>'state' as s from libraries where id = ${libraryId}`)
          .toEqual([{ t: 'object', s: 'requested' }]);
      }],
      ['DELETE /libraries/:id/player/server', async () => {
        await inject('DELETE', `/libraries/${libraryId}/player/server`);
      }, async () => {
        expect(await keyOf('playerUrl')).toBeNull();
        expect(await keyOf('contactString')).toBe('me@example.com');
      }],
      ['PUT /libraries/:id/player/scrobbling', async () => {
        await inject('PUT', `/libraries/${libraryId}/player/scrobbling`, { apiKey: 'a'.repeat(32), secret: 'b'.repeat(32) });
      }, async () => {
        expect(await keyOf('lastfmApiKey')).toMatch(/^enc:/);
      }],
      ['DELETE /libraries/:id/player/scrobbling', async () => {
        await inject('DELETE', `/libraries/${libraryId}/player/scrobbling`);
      }, async () => {
        expect(await keyOf('lastfmApiKey')).toBeNull();
        expect(await keyOf('contactString')).toBe('me@example.com');
      }],
      ['PUT /libraries/:id/updates/feed and /updates/skip (jsonb_set updates)', async () => {
        await inject('PUT', `/libraries/${libraryId}/updates/feed`, { enabled: false });
        await inject('PUT', `/libraries/${libraryId}/updates/skip`, { version: 'v9.9.9' });
      }, async () => {
        expect(await raw`select jsonb_typeof(settings->'updates') as t, settings->'updates'->>'skippedVersion' as v, settings->'updates'->>'enabled' as e from libraries where id = ${libraryId}`)
          .toEqual([{ t: 'object', v: '9.9.9', e: 'false' }]);
      }],
    ];

    for (const mode of ['shared', 'plain'] as const) {
      describe(`on the ${mode === 'shared' ? "API's shared client" : 'plain postgres.js serializers'}`, () => {
        for (const [name, write, check] of writers) {
          it(`${name} stores an object`, async () => {
            // Each writer on its own: a string an earlier one left is unwrapped first.
            await raw`update libraries set settings = (settings #>> '{}')::jsonb where id = ${libraryId} and jsonb_typeof(settings) = 'string'`;
            jsonbParams(mode);
            try {
              await write();
            } finally {
              jsonbParams('shared');
            }
            expect(await typeOf()).toBe('object');
            await check();
          });
        }
      });
    }

    it('leaves no library whose settings are not an object', async () => {
      expect(await raw`select count(*)::int as n from libraries where jsonb_typeof(settings) <> 'object'`).toEqual([{ n: 0 }]);
    });
  });
});

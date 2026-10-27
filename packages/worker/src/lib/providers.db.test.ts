/**
 * libraryTypesafeKey: the library's API key for the autotagger, read from the
 * module's own table and opened with this host's APP_SECRET. No key, no row
 * or no table (the module's tables never made) is null; a key that does not
 * open is null with one warning that names neither the key nor its hint.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeDb, setTypesafeKey } from '@tagave/db';
import { sealSecret } from '@tagave/core';
import { libraryTypesafeKey } from './providers.js';

const SECRET = 'test-app-secret-0123456789abcdef01234567';
const OTHER = 'other-app-secret-0123456789abcdef0123456';

function ctxWith(sql: unknown) {
  const warn = vi.fn();
  return { ctx: { sql, logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } as any, warn };
}

describe('libraryTypesafeKey without the module table', () => {
  const saved = process.env.APP_SECRET;
  afterEach(() => { if (saved === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = saved; });

  it('a missing table reads as no key; any other error is thrown', async () => {
    process.env.APP_SECRET = SECRET;
    const missing = Object.assign(new Error('relation "decider_library_settings" does not exist'), { code: '42P01' });
    const { ctx, warn } = ctxWith(async () => { throw missing; });
    expect(await libraryTypesafeKey(ctx, randomUUID())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    const { ctx: broken } = ctxWith(async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); });
    await expect(libraryTypesafeKey(broken, randomUUID())).rejects.toThrow(/connection lost/);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('libraryTypesafeKey (shared db: its own libraries only)', () => {
  let client: any;
  const saved = process.env.APP_SECRET;
  const userId = randomUUID();
  const withKey = randomUUID();
  const withoutKey = randomUUID();
  const noRow = randomUUID();
  const plain = `ts-${randomUUID()}-q7r8`;

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`tskey-${userId}@test.com`}, 'x')`;
    for (const id of [withKey, withoutKey, noRow]) await client`insert into libraries (id, owner_user_id, name) values (${id}, ${userId}, 'TypeSafe key')`;
    await setTypesafeKey(client, withKey, sealSecret(plain, SECRET), 'q7r8');
    await client`insert into decider_library_settings (library_id, config) values (${withoutKey}, '{"monthlyCap":5}'::jsonb)`;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = saved;
    await client`delete from libraries where id = any(${[withKey, withoutKey, noRow]}::uuid[])`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('opens the sealed key with APP_SECRET; no key or no row is null', async () => {
    process.env.APP_SECRET = SECRET;
    const { ctx, warn } = ctxWith(client);
    expect(await libraryTypesafeKey(ctx, withKey)).toBe(plain);
    expect(await libraryTypesafeKey(ctx, withoutKey)).toBeNull();
    expect(await libraryTypesafeKey(ctx, noRow)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a key that does not open here, or no APP_SECRET: null, warned once, with no key material', async () => {
    const sealed = (await client`select sealed_key from decider_library_settings where library_id = ${withKey}`)[0].sealed_key as string;
    process.env.APP_SECRET = OTHER;
    const { ctx, warn } = ctxWith(client);
    expect(await libraryTypesafeKey(ctx, withKey)).toBeNull();
    expect(await libraryTypesafeKey(ctx, withKey)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    delete process.env.APP_SECRET;
    expect(await libraryTypesafeKey(ctx, withKey)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const text of warn.mock.calls.flat().map((m) => JSON.stringify(m))) {
      for (const leak of [plain, sealed, 'q7r8', sealed.slice(0, 16)]) expect(text).not.toContain(leak);
    }
  });
});

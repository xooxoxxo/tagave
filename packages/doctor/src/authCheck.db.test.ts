import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '@liner/db';
import { checkPublicUrl } from './authCheck.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('checkPublicUrl against passkeys (integration)', () => {
  let admin: postgres.Sql;
  let name: string;
  let dbUrl: string;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `liner_doc_auth_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await runMigrations(dbUrl, { log: () => undefined });
    const sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
    const [user] = await sql`insert into users (email, display_name) values ('o@example.com', 'O') returning id`;
    await sql`insert into auth_passkeys (user_id, public_key, credential_id, device_type, backed_up, rp_id)
              values (${user!['id']}, 'pk', 'cred-1', 'singleDevice', false, 'music.example.com'),
                     (${user!['id']}, 'pk', 'cred-2', 'singleDevice', false, 'music.example.com')`;
    await sql.end();
  });

  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('passes when the passkeys were made for PUBLIC_URL', async () => {
    expect(await checkPublicUrl(dbUrl, { PUBLIC_URL: 'https://music.example.com' })).toMatchObject({
      status: 'pass',
      detail: 'https://music.example.com, 2 passkeys registered for it',
    });
  });

  it('warns when PUBLIC_URL moved to another host', async () => {
    const check = await checkPublicUrl(dbUrl, { PUBLIC_URL: 'https://tagave.home.example' });
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('2 passkeys for music.example.com');
    expect(check.detail).toContain('do not work at tagave.home.example');
  });
});

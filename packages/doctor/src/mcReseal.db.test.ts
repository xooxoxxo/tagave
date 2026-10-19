/**
 * tagave-doctor reseal and Music Connections: after an APP_SECRET rotation
 * a link's sealed tokens, and a pending link's client secret and PKCE code
 * verifier, open with the new secret; a second run changes nothing; a wrong
 * old secret changes nothing; values neither secret opens (stale links) are
 * counted and never stop the other steps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '@tagave/db';
import { openOne, openTokens, sealOne, sealTokens } from '@tagave/core/mc';
import { openSecret, sealSecret } from '@tagave/core';
import { resealCredentials, resealMcSecrets } from './reseal.js';

const url = process.env.TEST_DATABASE_URL;
const OLD = 'old-app-secret-0123456789abcdef0123456789';
const NEW = 'new-app-secret-0123456789abcdef0123456789';
const tokens = { access_token: 'acc', refresh_token: 'ref', client_secret: 'sec', access_expires_at: '2026-10-19T00:00:00.000Z' };

describe.skipIf(!url)('reseal: Music Connections links (integration)', () => {
  let admin: postgres.Sql;
  let name: string;
  let dbUrl: string;
  let sql: postgres.Sql;
  let userId: string;
  const libraryId = randomUUID();
  const LOST = 'lost-secret-0123456789abcdef0123456789';

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `tagave_doc_mcseal_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await runMigrations(dbUrl, { log: () => undefined });
    sql = postgres(dbUrl, { max: 2, onnotice: () => undefined });
    const [user] = await sql`insert into users (email, display_name) values ('o@example.com', 'O') returning id::text as id`;
    userId = user!['id'];
    await sql`insert into libraries (id, owner_user_id, name) values (${libraryId}, ${userId}, 'Reseal')`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql`update libraries set settings = ${sql.json({ discogsToken: sealSecret('discogs-token', OLD) })} where id = ${libraryId}`;
    await sql`delete from mc_links`;
    await sql`delete from mc_pending`;
    await sql`insert into mc_links (user_id, remote_url, manifest, client_id, sealed_tokens, state)
              values (${userId}, 'http://192.168.1.9:8080', '{}'::jsonb, 'cid', ${sealTokens(tokens, OLD)}, 'active'),
                     (${userId}, 'http://192.168.1.10:8080', '{}'::jsonb, 'cid', '', 'revoked')`;
    await sql`insert into mc_pending (state_hash, user_id, remote_url, manifest, client_id, code_verifier_sealed, client_secret_sealed, requested_scopes)
              values ('h1', ${userId}, 'http://192.168.1.11:8080', '{}'::jsonb, 'cid', ${sealOne('verifier', OLD)}, ${sealOne('pending-secret', OLD)}, ${['critic-scores:read']})`;
  });

  it('re-encrypts link tokens and the pending secrets; a second run changes nothing', async () => {
    expect(await resealMcSecrets(sql, OLD, NEW)).toEqual({ resealed: 3, alreadyCurrent: 0, unreadable: 0 });
    const [link] = await sql<Array<{ sealed_tokens: string }>>`select sealed_tokens from mc_links where state = 'active'`;
    expect(openTokens(link!.sealed_tokens, NEW)).toEqual(tokens);
    expect(openTokens(link!.sealed_tokens, OLD)).toBeNull();
    const [p] = await sql<Array<{ code_verifier_sealed: string; client_secret_sealed: string }>>`select code_verifier_sealed, client_secret_sealed from mc_pending`;
    expect(openOne(p!.code_verifier_sealed, NEW)).toBe('verifier');
    expect(openOne(p!.client_secret_sealed, NEW)).toBe('pending-secret');
    // a revoked link keeps its empty value
    expect((await sql`select sealed_tokens from mc_links where state = 'revoked'`)[0]!['sealed_tokens']).toBe('');
    expect(await resealMcSecrets(sql, OLD, NEW)).toEqual({ resealed: 0, alreadyCurrent: 3, unreadable: 0 });
  });

  async function doctor(oldSecret = OLD): Promise<{ warned: string }> {
    const saved = { old: process.env['TAGAVE_OLD_APP_SECRET'], app: process.env['APP_SECRET'] };
    process.env['TAGAVE_OLD_APP_SECRET'] = oldSecret;
    process.env['APP_SECRET'] = NEW;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await resealCredentials(dbUrl);
      return { warned: warn.mock.calls.flat().join('\n') };
    } finally {
      log.mockRestore();
      warn.mockRestore();
      if (saved.old === undefined) delete process.env['TAGAVE_OLD_APP_SECRET'];
      else process.env['TAGAVE_OLD_APP_SECRET'] = saved.old;
      if (saved.app === undefined) delete process.env['APP_SECRET'];
      else process.env['APP_SECRET'] = saved.app;
    }
  }
  const discogs = async () =>
    ((await sql`select settings from libraries where id = ${libraryId}`)[0]!['settings'] as { discogsToken: string }).discogsToken;
  const snapshot = async () => ({
    links: await sql`select sealed_tokens from mc_links order by remote_url`,
    pending: await sql`select code_verifier_sealed, client_secret_sealed from mc_pending`,
    discogs: await discogs(),
  });

  it('a wrong old secret changes nothing', async () => {
    const before = await snapshot();
    // on its own, the Music Connections step opens nothing and so changes nothing
    expect(await resealMcSecrets(sql, 'wrong-secret-0123456789abcdef0123456789', NEW)).toEqual({ resealed: 0, alreadyCurrent: 0, unreadable: 3 });
    expect(await snapshot()).toEqual(before);
    // the doctor checks the old secret against the provider secrets first and stops
    await expect(doctor('wrong-secret-0123456789abcdef0123456789')).rejects.toThrow(/TAGAVE_OLD_APP_SECRET right\? Nothing was changed/);
    expect(await snapshot()).toEqual(before);
  });

  it('a re-run is a no-op, even with a stale link that opens with neither secret', async () => {
    await sql`insert into mc_links (user_id, remote_url, manifest, client_id, sealed_tokens, state)
              values (${userId}, 'http://192.168.1.12:8080', '{}'::jsonb, 'cid', ${sealTokens(tokens, LOST)}, 'needs_reapproval')`;
    expect((await doctor()).warned).toMatch(/1 Music Connections value\(s\) open with neither secret/);
    const after = await snapshot();
    expect(openSecret(after.discogs, NEW)).toBe('discogs-token');
    const second = await doctor();
    expect(second.warned).toMatch(/1 Music Connections value/);
    expect(await snapshot()).toEqual(after);
  });

  it('when the only links are stale (neither secret opens them), the provider secrets are still re-encrypted', async () => {
    await sql`update mc_links set sealed_tokens = ${sealTokens(tokens, LOST)}, state = 'needs_reapproval' where state = 'active'`;
    await sql`update mc_pending set code_verifier_sealed = ${sealOne('verifier', LOST)}, client_secret_sealed = ${sealOne('pending-secret', LOST)}`;
    const { warned } = await doctor();
    expect(warned).toMatch(/3 Music Connections value\(s\) open with neither secret/);
    expect(openSecret(await discogs(), NEW)).toBe('discogs-token');
    const [link] = await sql<Array<{ sealed_tokens: string }>>`select sealed_tokens from mc_links where state = 'needs_reapproval'`;
    expect(openTokens(link!.sealed_tokens, LOST)).toEqual(tokens);
  });

  it('a value neither secret opens is left as it is and counted; the rest are re-encrypted', async () => {
    await sql`update mc_links set sealed_tokens = ${sealTokens(tokens, 'lost-secret-0123456789abcdef0123456789')} where state = 'active'`;
    expect(await resealMcSecrets(sql, OLD, NEW)).toEqual({ resealed: 2, alreadyCurrent: 0, unreadable: 1 });
  });

  it('tagave-doctor reseal covers them', async () => {
    expect((await doctor()).warned).toBe('');
    const [link] = await sql<Array<{ sealed_tokens: string }>>`select sealed_tokens from mc_links where state = 'active'`;
    expect(openTokens(link!.sealed_tokens, NEW)).toEqual(tokens);
    expect(openSecret(await discogs(), NEW)).toBe('discogs-token');
  });
});

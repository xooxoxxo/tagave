/**
 * 0093: provenance columns, backfilled from the reason each writer used.
 * The Music Connections trigger of 0048 does not compare the new columns,
 * so the backfill logs no album.identity change.
 * 0094: the trigger then compares the decision's kind and probability too;
 * applying it logs nothing, and a later change of either logs the album.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('0093 match provenance (upgrade with data)', () => {
  let admin: postgres.Sql; let db: { url: string; name: string }; let sql: postgres.Sql;
  const user = randomUUID(); const lib = randomUUID(); const rg = randomUUID(); const rel = randomUUID();
  const rows: Record<string, { reason: string; status: string; by: string }> = {
    queue: { reason: 'accepted in review queue', status: 'confirmed', by: 'user' },
    mbid: { reason: 'manual MBID entry', status: 'confirmed', by: 'user' },
    rules: { reason: 'auto-accept rules: 97% match (MusicBrainz)', status: 'auto', by: 'system' },
    strong: { reason: 'auto-accept: distance 0.0100 (musicbrainz)', status: 'auto', by: 'system' },
    chip: { reason: 'chip-rule auto-accept: 4 green, 0 yellow, 0 red (distance 0.1000)', status: 'auto', by: 'system' },
    first: { reason: 'first-candidate auto-accept: distance 0.2 (3 green, 1 yellow, 0 red)', status: 'auto', by: 'system' },
    acoustid: { reason: 'acoustid auto-accept: 90% of tracks fingerprint-matched', status: 'auto', by: 'system' },
    superseded: { reason: 'superseded by user decision', status: 'rejected', by: 'system' },
    supersededUser: { reason: 'superseded by re-identification', status: 'rejected', by: 'user' },
  };
  const albumOf: Record<string, string> = {};
  let identityRowsBefore = 0;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0093');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${user}, ${'p-' + user + '@test.com'}, 'P', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${lib}, ${user}, 'P', '{}')`;
    await sql`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'RG')`;
    await sql`insert into releases (id, release_group_id, mbid, title) values (${rel}, ${rg}, ${randomUUID()}, 'R')`;
    for (const k of Object.keys(rows)) {
      const id = randomUUID(); albumOf[k] = id;
      await sql`insert into local_albums (id, library_id, cluster_key, state, release_group_id, release_id) values (${id}, ${lib}, ${'k-' + k}, 'matched', ${rg}, ${rel})`;
      await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason)
                values (${lib}, ${id}, ${rel}, 0.0100, ${rows[k]!.status}, ${rows[k]!.by}, ${rows[k]!.reason})`;
    }
    identityRowsBefore = (await sql`select count(*)::int as n from facet_changes where facet = 'album.identity@1'`)[0]!['n'] as number;
    await migrateUpTo(db.url, '0094'); // 0093 only
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${db.name} with (force)`);
    await admin.end({ timeout: 5 });
  });

  const kind = async (k: string) => (await sql`select decided_kind from album_matches where local_album_id = ${albumOf[k]!}`)[0]!['decided_kind'];

  it('classifies live rows by the reason their writer used', async () => {
    expect(await kind('queue')).toBe('user');
    expect(await kind('mbid')).toBe('user');
    expect(await kind('rules')).toBe('rule');
    for (const k of ['strong', 'chip', 'first', 'acoustid']) expect(await kind(k)).toBe('system');
  });

  it('a superseded row whose reason was overwritten is unknown', async () => {
    expect(await kind('superseded')).toBe('unknown');
    expect(await kind('supersededUser')).toBe('unknown');
  });

  it('the backfill logged no album.identity change (no linked app re-pulls the library)', async () => {
    const [r] = await sql`select count(*)::int as n from facet_changes where facet = 'album.identity@1'`;
    expect(r!['n']).toBe(identityRowsBefore);
  });

  it('a person is kept as null when the user is deleted', async () => {
    const other = randomUUID();
    await sql`insert into users (id, email, display_name, password_hash) values (${other}, ${'q-' + other + '@test.com'}, 'Q', 'x')`;
    await sql`update album_matches set decided_by_user_id = ${other} where local_album_id = ${albumOf['queue']!}`;
    await sql`delete from users where id = ${other}`;
    const [r] = await sql`select decided_by_user_id from album_matches where local_album_id = ${albumOf['queue']!}`;
    expect(r!['decided_by_user_id']).toBeNull();
  });

  it('refuses an unknown kind and a probability outside 0..1', async () => {
    await expect(sql`update album_matches set decided_kind = 'oracle' where local_album_id = ${albumOf['queue']!}`).rejects.toThrow(/check/);
    await expect(sql`update album_matches set probability = 1.5 where local_album_id = ${albumOf['queue']!}`).rejects.toThrow();
  });

  const identityRows = async (key?: string) =>
    (await sql`select count(*)::int as n from facet_changes where facet = 'album.identity@1' and (${key ?? null}::text is null or key = ${key ?? null})`)[0]!['n'] as number;

  it('applying 0094 logs nothing by itself', async () => {
    const before = await identityRows();
    await migrateAll(db.url);
    const after = await identityRows();
    expect(after).toBe(before);
  });
  it('a change of decided_kind or probability logs the album\'s identity once', async () => {
    const before = await identityRows(rg);
    await sql`update album_matches set decided_kind = 'model', probability = 0.9940 where local_album_id = ${albumOf['strong']!}`;
    const after = await identityRows(rg);
    expect(after).toBe(before + 1);
  });
  it('a change of decided_by alone logs the album\'s identity once (the feed reads it)', async () => {
    const before = await identityRows(rg);
    await sql`update album_matches set decided_by = 'user' where local_album_id = ${albumOf['first']!}`;
    expect(await identityRows(rg)).toBe(before + 1);
  });
  it('a change of probability alone logs the album\'s identity once', async () => {
    const before = await identityRows(rg);
    await sql`update album_matches set probability = 0.9100 where local_album_id = ${albumOf['acoustid']!}`;
    expect(await identityRows(rg)).toBe(before + 1);
  });
  it('a change of the reason alone still logs nothing', async () => {
    const before = await identityRows();
    await sql`update album_matches set reason = reason || ' ' where local_album_id = ${albumOf['chip']!}`;
    const after = await identityRows();
    expect(after).toBe(before);
  });
});

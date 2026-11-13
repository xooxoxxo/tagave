/**
 * 0077: every linked album links again (the write-back put pairs on the
 * wrong rows), previewed canonical plans go back to draft, a paused apply's
 * unwritten items are skipped, and plan items gain the pairing columns.
 * Links themselves stay until the relink replaces them.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('0077 relink tracks migration (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const libraryId = randomUUID();
  const linked = randomUUID();
  const unlinked = randomUUID();
  const trackId = randomUUID();
  const canonicalId = randomUUID();
  const plans = { previewed: randomUUID(), manual: randomUUID(), paused: randomUUID(), applied: randomUUID() };
  const items = { pausedPending: randomUUID(), pausedApplied: randomUUID(), appliedItem: randomUUID() };

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0077');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    const userId = randomUUID();
    const rootId = randomUUID();
    const fileId = randomUUID();
    const fileId2 = randomUUID();
    const rgId = randomUUID();
    const relId = randomUUID();
    await sql`insert into users (id, email, display_name, password_hash) values (${userId}, ${`r-${userId}@test.com`}, 'R', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${userId}, 'R', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/music', 'm')`;
    await sql`insert into files (id, library_id, scan_root_id, rel_path, size_bytes, mtime, handler) values (${fileId}, ${libraryId}, ${rootId}, 'A/1.flac', 1, 1, 'audio'), (${fileId2}, ${libraryId}, ${rootId}, 'A/2.flac', 1, 1, 'audio')`;
    await sql`insert into release_groups (id, mbid, title, artist_credit) values (${rgId}, ${rgId}, 'V', '[]')`;
    await sql`insert into releases (id, release_group_id, title) values (${relId}, ${rgId}, 'V')`;
    await sql`insert into canonical_tracks (id, release_id, medium_no, position, title, artist_credit) values (${canonicalId}, ${relId}, 1, 1, 'Clouds', '[]')`;
    await sql`insert into local_albums (id, library_id, cluster_key, state, release_id, tracks_linked_at)
              values (${linked}, ${libraryId}, 'a', 'matched', ${relId}, now()), (${unlinked}, ${libraryId}, 'b', 'pending', null, null)`;
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, canonical_track_id, match_distance, state)
              values (${trackId}, ${linked}, ${fileId}, ${canonicalId}, 0, 'matched')`;
    // Bound as text into ::jsonb, postgres.js stores these as JSON strings,
    // the shape some older rows have (0051): the migration reads both.
    const canonical = JSON.stringify({ preset: 'canonical_ids_and_fill' });
    const scope = JSON.stringify({ type: 'library' });
    await sql`insert into tag_plans (id, library_id, name, scope, policy, status, created_by) values
      (${plans.previewed}, ${libraryId}, 'p', ${scope}::jsonb, ${canonical}::jsonb, 'previewed', ${userId}),
      (${plans.manual}, ${libraryId}, 'm', ${scope}::jsonb, ${JSON.stringify({ preset: 'manual', values: { album: 'X' } })}::jsonb, 'previewed', ${userId}),
      (${plans.paused}, ${libraryId}, 'z', ${scope}::jsonb, ${canonical}::jsonb, 'paused', ${userId}),
      (${plans.applied}, ${libraryId}, 'a', ${scope}::jsonb, ${canonical}::jsonb, 'applied', ${userId})`;
    await sql`insert into tag_plan_items (id, tag_plan_id, audio_file_id, before, after, diff, status, audio_hash_before, audio_hash_after) values
      (${items.pausedPending}, ${plans.paused}, ${fileId}, '{}', '{}', '[]', 'pending', null, null),
      (${items.pausedApplied}, ${plans.paused}, ${fileId2},'{}', '{}', '[]', 'applied', 'h', 'h'),
      (${items.appliedItem}, ${plans.applied}, ${fileId}, '{}', '{}', '[]', 'applied', 'h', 'h')`;
    await migrateAll(db.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('puts every linked album back in the relink sweep and keeps its links meanwhile', async () => {
    const albums = await sql`select id, tracks_linked_at from local_albums where library_id = ${libraryId}`;
    expect(albums.every((a) => a['tracks_linked_at'] === null)).toBe(true);
    const [track] = await sql`select canonical_track_id, state from local_tracks where id = ${trackId}`;
    expect(track).toMatchObject({ canonical_track_id: canonicalId, state: 'matched' });
  });

  it('sends previewed canonical plans back to draft and leaves manual and finished ones', async () => {
    const rows = await sql`select id, status from tag_plans where library_id = ${libraryId}`;
    const status = Object.fromEntries(rows.map((r) => [r['id'], r['status']]));
    expect(status).toEqual({ [plans.previewed]: 'draft', [plans.manual]: 'previewed', [plans.paused]: 'paused', [plans.applied]: 'applied' });
  });

  it('skips the unwritten items of a paused apply and keeps what was written', async () => {
    const rows = await sql`select id, status, error from tag_plan_items`;
    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]));
    expect(byId[items.pausedPending]).toMatchObject({ status: 'skipped', error: 'Track links repaired' });
    expect(byId[items.pausedApplied]).toMatchObject({ status: 'applied', error: null });
    expect(byId[items.appliedItem]).toMatchObject({ status: 'applied' });
  });

  it('adds the pairing columns to plan items', async () => {
    const cols = await sql`select column_name from information_schema.columns
                           where table_name = 'tag_plan_items' and column_name in ('canonical_track_id', 'match_distance') order by 1`;
    expect(cols.map((c) => c['column_name'])).toEqual(['canonical_track_id', 'match_distance']);
  });
});

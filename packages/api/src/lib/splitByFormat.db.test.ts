/**
 * Split by format writes the split-off album, its pins and its moved track
 * rows in one transaction under the album key lock (albumKeyLock). The
 * worker's zero-track sweep takes the same lock, so it never sees the new
 * album without its tracks and never deletes it before they move.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { albumKeyLock, makeDb } from '@tagave/db';
import { splitAlbumByFormat } from './splitByFormat.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('splitAlbumByFormat under the album key lock (db)', () => {
  let db: any; let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const albumId = randomUUID();
  const splitKey = `split:${albumId}:lossy`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db; sql = made.client;
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`splk-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SPLK', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-splk', 'splk')`;
    await sql`insert into local_albums (id, library_id, cluster_key, state, dir_paths, title_guess)
              values (${albumId}, ${libraryId}, ${`test-${albumId}`}, 'matched', ${['A/B']}::text[], 'B')`;
    for (const [rel, lossless] of [['A/B/1.flac', true], ['A/B/2.flac', true], ['A/B/1.mp3', false], ['A/B/2.mp3', false]] as const) {
      const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, status, lossless, duration_ms, handler)
                            values (${libraryId}, ${rootId}, ${rel}, 'present', ${lossless}, 1000, 'audio') returning id`;
      await sql`insert into local_tracks (local_album_id, audio_file_id, state, origin) values (${albumId}, ${f.id}, 'unmatched', 'file')`;
    }
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('waits for the lock, shows no empty split album meanwhile, then commits the album with its tracks', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = sql.begin(async (tx: any) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${albumKeyLock(libraryId, splitKey)}, 0))`;
      locked();
      await released;
    });
    await isLocked;
    let done = false;
    const split = splitAlbumByFormat(db, { libraryId, albumId, userId, keep: 'lossless' }).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(await sql`select id from local_albums where library_id = ${libraryId} and cluster_key = ${splitKey}`).toHaveLength(0);
    release();
    await holder;
    const r = await split;
    const [created] = await sql`select cluster_key, track_count from local_albums where id = ${r.newAlbumId}`;
    expect(created).toEqual({ cluster_key: splitKey, track_count: 2 });
    expect(await sql`select 1 from local_tracks where local_album_id = ${r.newAlbumId}`).toHaveLength(2);
    expect(await sql`select 1 from cluster_overrides where local_album_id = ${r.newAlbumId}`).toHaveLength(2);
  });
});

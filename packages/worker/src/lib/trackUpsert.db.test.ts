/**
 * Re-clustering updates local_tracks in place: ids, canonical links, player
 * map rows and favourites survive; a changed title clears the album's
 * tracks_linked_at so tracks.link runs again; a file that changes album
 * loses its old release link; nothing is ever duplicated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { clusterDirJob } from '../jobs/clusterDir.js';
import { upsertTracks } from './trackUpsert.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('tracks update in place (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const files = [randomUUID(), randomUUID(), randomUUID()];
  const groupId = randomUUID();
  const canonicalId = randomUUID();
  const recordingId = randomUUID();
  const tags = (title: string, n: number, album = 'Album One') =>
    ({ common: { album, albumartist: 'Artist', artist: 'Artist', title, track: { no: n, of: 3 } } });
  const tracksOf = async () => sql`select lt.id, lt.audio_file_id, lt.local_album_id, lt.title_guess, lt.canonical_track_id
                                   from local_tracks lt where lt.audio_file_id = any(${files}::uuid[]) order by lt.track_no`;
  const link = (trackId: string) => sql`update local_tracks
      set canonical_track_id = ${canonicalId}, recording_id = ${recordingId}, match_distance = 0.125, state = 'matched'
    where id = ${trackId}`;
  const linkOf = async (trackId: string) => (await sql`select canonical_track_id, recording_id, match_distance::float8 as match_distance, state
                                                        from local_tracks where id = ${trackId}`)[0];
  const cluster = (dirPath = 'Artist/Album One') => clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`tu-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'TU', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/nonexistent-tu', 'tu', 'ok')`;
    for (const [i, id] of files.entries()) {
      await sql`insert into files (id, library_id, scan_root_id, rel_path, status, duration_ms, tags_raw, handler)
                values (${id}, ${libraryId}, ${rootId}, ${`Artist/Album One/0${i + 1}.flac`}, 'present', 1000, ${JSON.stringify(tags(`Song ${i + 1}`, i + 1))}::text::jsonb, 'audio')`;
    }
    const releaseId = randomUUID();
    await sql`insert into release_groups (id, mbid, title) values (${groupId}, ${groupId}, 'TU Release')`;
    await sql`insert into releases (id, release_group_id, title) values (${releaseId}, ${groupId}, 'TU Release')`;
    await sql`insert into canonical_tracks (id, release_id, title) values (${canonicalId}, ${releaseId}, 'Song 1')`;
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql`delete from release_groups where id = ${groupId}`;
    await sql.end({ timeout: 5 });
  });

  it('a second cluster run keeps every track id and the player map', async () => {
    await cluster();
    const before = await tracksOf();
    expect(before).toHaveLength(3);
    await sql`insert into player_track_map (local_track_id, server_key, song_id, matched_by) values (${before[0].id}, 'bundled', 's1', 'path')`;
    await sql`update local_albums set tracks_linked_at = now() where id = ${before[0].local_album_id}`;
    await cluster();
    const after = await tracksOf();
    expect(after.map((t: any) => t.id)).toEqual(before.map((t: any) => t.id));
    expect(await sql`select 1 from player_track_map where local_track_id = ${before[0].id}`).toHaveLength(1);
    // nothing a link depends on changed: the album stays linked
    const [a] = await sql`select tracks_linked_at from local_albums where id = ${before[0].local_album_id}`;
    expect(a.tracks_linked_at).not.toBeNull();
  });

  it('an unchanged re-cluster writes no track row (xmin stays)', async () => {
    const xmins = async () => (await sql`select id, xmin::text as x from local_tracks
                                         where audio_file_id = any(${files}::uuid[]) order by id`).map((r: any) => `${r.id}:${r.x}`);
    const before = await xmins();
    expect(before).toHaveLength(3);
    await cluster();
    expect(await xmins()).toEqual(before);
  });

  it('a retitled track keeps its id and clears the album tracks_linked_at', async () => {
    const [first] = await tracksOf();
    await link(first.id);
    await sql`update files set tags_raw = ${JSON.stringify(tags('Renamed', 1))}::text::jsonb where id = ${files[0]}`;
    await cluster();
    const [again] = await tracksOf();
    expect(again.id).toBe(first.id);
    expect(again.title_guess).toBe('Renamed');
    // same album, so the link survives the retitle
    expect(await linkOf(first.id)).toEqual({ canonical_track_id: canonicalId, recording_id: recordingId, match_distance: 0.125, state: 'matched' });
    const [a] = await sql`select tracks_linked_at from local_albums where id = ${first.local_album_id}`;
    expect(a.tracks_linked_at).toBeNull();
  });

  it('a file that leaves for another album keeps its track id but not its release link', async () => {
    const [first] = await tracksOf();
    await link(first.id);
    await sql`update files set tags_raw = ${JSON.stringify(tags('Renamed', 1, 'Other Album'))}::text::jsonb where id = ${files[0]}`;
    await cluster();
    const [row] = await sql`select id, local_album_id, recording_id, state from local_tracks where audio_file_id = ${files[0]}`;
    expect(row.id).toBe(first.id);
    expect(row.local_album_id).not.toBe(first.local_album_id);
    expect(row.recording_id).toBeNull();
    expect(row.state).toBe('unmatched');
    expect(await linkOf(first.id)).toEqual({ canonical_track_id: null, recording_id: null, match_distance: null, state: 'unmatched' });
  });

  it('two concurrent cluster runs of a plain-file folder never duplicate tracks', async () => {
    await Promise.all([cluster(), cluster(), cluster()]);
    const [n] = await sql`select count(*)::int as n from local_tracks where audio_file_id = any(${files}::uuid[])`;
    expect(n.n).toBe(3);
  });

  it('a file no longer in the scope keeps its row (missing files stay attached)', async () => {
    await sql`update files set status = 'missing' where id = ${files[2]}`;
    await cluster();
    expect(await sql`select 1 from local_tracks where audio_file_id = ${files[2]}`).toHaveLength(1);
    await sql`update files set status = 'present' where id = ${files[2]}`;
  });

  it('inserted counts only rows actually written', async () => {
    // files[1]'s row exists but is outside fileIds, so its insert conflicts.
    const [t] = await sql`select local_album_id from local_tracks where audio_file_id = ${files[1]}`;
    const res = await upsertTracks(ctx, `tu-${randomUUID()}`, [files[2]!], [
      { localAlbumId: t.local_album_id, audioFileId: files[1]!, discNo: null, trackNo: 2, titleGuess: 'Song 2', artistGuess: 'Artist',
        durationMs: 1000, origin: 'file', cueStartMs: null, cueRelPath: null },
    ]);
    expect(res.inserted).toBe(0);
    expect(res.deleted).toBe(1); // files[2] produced no row in this call
  });
});

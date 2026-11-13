import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFile } from 'music-metadata';
import pino from 'pino';
import sharp from 'sharp';
import { hashAudioStream } from '@tagave/core';
import { makeDb, restartMaintenanceTask, saveMaintenanceTask } from '@tagave/db';
import { embedCoverJob } from './embedCover.js';
import { resolvePythonInterpreter } from '../lib/tagWriter.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const canWrite = spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync(resolvePythonInterpreter(), ['-c', 'import mutagen']).status === 0;

describe.skipIf(!databaseUrl || !canWrite)('local cover embedding', () => {
  const user = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const fileId = randomUUID();
  let connection: Awaited<ReturnType<typeof makeDb>>;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    connection = await makeDb(databaseUrl!);
    dir = await mkdtemp(path.join(tmpdir(), 'tagave-cover-'));
    file = path.join(dir, 'track.flac');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.2', '-metadata', 'title=Original title', file]);
    const sql = connection.client;
    await sql`insert into users (id, email, password_hash) values (${user}, ${`cover-${user}@test.test`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Covers', ${user}, '{"tagWritesEnabled":true}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, writable) values (${rootId}, ${libraryId}, ${dir}, 'Fixture', true)`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess) values (${albumId}, ${libraryId}, ${albumId}, 'Album')`;
    await sql`insert into files (id, library_id, scan_root_id, rel_path, status, handler)
      values (${fileId}, ${libraryId}, ${rootId}, 'track.flac', 'present', 'audio')`;
    await sql`insert into local_tracks (local_album_id, audio_file_id, origin) values (${albumId}, ${fileId}, 'file')`;
    await sql`insert into gaps (library_id, subject_id, subject_type, kind, flag)
      values (${libraryId}, ${albumId}, 'local_album', 'quality', 'noEmbeddedArt')`;
  });

  afterAll(async () => {
    if (connection) {
      await connection.client`delete from libraries where id = ${libraryId}`;
      await connection.client`delete from users where id = ${user}`;
      await connection.client.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('leaves audio untouched without a local cover and embeds it on retry', async () => {
    const sql = connection.client;
    const ctx = { sql, db: connection.db, logger: pino({ level: 'silent' }), boss: { send: async () => null } as never };
    const before = await hashAudioStream(file, 'flac');
    const input = { albumId, fileIds: [fileId] };
    const task = await saveMaintenanceTask(sql, {
      libraryId, kind: 'embed-cover', scope: albumId, subjectId: albumId, queue: 'files.embedCover', input, stage: 'Queued',
    });
    await embedCoverJob(ctx, { ...input, maintenance: { taskId: task.id, attemptId: task.attempt_id } });
    expect(await sql`select state, error from maintenance_tasks where id = ${task.id}`)
      .toEqual([{ state: 'failed', error: expect.stringContaining('cover.jpg') }]);
    expect((await parseFile(file)).common.picture).toBeUndefined();

    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'navy' } }).png().toFile(path.join(dir, 'cover.png'));
    const retry = await restartMaintenanceTask(sql, libraryId, task.id, task.attempt);
    await embedCoverJob(ctx, { ...input, maintenance: { taskId: task.id, attemptId: retry!.attempt_id } });
    expect(await sql`select state, error, progress from maintenance_tasks where id = ${task.id}`)
      .toEqual([{ state: 'done', error: null, progress: { done: 1, total: 1 } }]);
    expect((await parseFile(file)).common).toMatchObject({ title: 'Original title', picture: [{ format: 'image/jpeg' }] });
    expect(await hashAudioStream(file, 'flac')).toBe(before);
    expect(await sql`select has_embedded_art from files where id = ${fileId}`).toEqual([{ has_embedded_art: true }]);
    expect(await sql`select state from gaps where subject_id = ${albumId}`).toEqual([{ state: 'resolved' }]);
  });
});

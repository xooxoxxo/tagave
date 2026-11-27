import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { FileGate, setFileGate, type GateOp } from '../lib/fileGate.js';
import { tempPrefixFor } from '../lib/safeFileWriter.js';
import { FolderOfflineError } from '../lib/folderOffline.js';
import { WAITING_STAGE } from '../lib/parking.js';

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

  it('an offline music folder parks the task: it waits, the file untouched', async () => {
    const sql = connection.client;
    const ctx = { sql, db: connection.db, logger: pino({ level: 'silent' }), boss: { send: async () => null } as never };
    const before = await hashAudioStream(file, 'flac');
    const input = { albumId, fileIds: [fileId] };
    const task = await saveMaintenanceTask(sql, {
      libraryId, kind: 'embed-cover', scope: `${albumId}:offline`, subjectId: albumId, queue: 'files.embedCover', input, stage: 'Queued',
    });
    class OfflineGate extends FileGate {
      override run<T>(root: string): Promise<T> {
        return Promise.reject(new FolderOfflineError(root, 'io_error', 'EIO'));
      }
    }
    setFileGate(new OfflineGate());
    try {
      await embedCoverJob(ctx, { ...input, maintenance: { taskId: task.id, attemptId: task.attempt_id } });
    } finally {
      setFileGate(null);
    }
    expect(await sql`select state, stage from maintenance_tasks where id = ${task.id}`)
      .toEqual([{ state: 'waiting', stage: WAITING_STAGE }]);
    expect(await sql`select queue, reason from parked_jobs where scan_root_id = ${rootId}`)
      .toEqual([{ queue: 'maintenance', reason: 'io_error' }]);
    expect(await hashAudioStream(file, 'flac')).toBe(before);
  });

  /** A fresh album of one flac file (no cover) in its own folder, with a cover.png beside it. */
  async function freshAlbum(name: string) {
    const sql = connection.client;
    const folder = path.join(dir, name);
    await mkdir(folder, { recursive: true });
    const track = path.join(folder, 'track.flac');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.2', '-metadata', 'title=Original title', track]);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'teal' } }).png().toFile(path.join(folder, 'cover.png'));
    const album = randomUUID();
    const id = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess) values (${album}, ${libraryId}, ${album}, ${name})`;
    await sql`insert into files (id, library_id, scan_root_id, rel_path, status, handler)
      values (${id}, ${libraryId}, ${rootId}, ${`${name}/track.flac`}, 'present', 'audio')`;
    await sql`insert into local_tracks (local_album_id, audio_file_id, origin) values (${album}, ${id}, 'file')`;
    const input = { albumId: album, fileIds: [id] };
    const task = await saveMaintenanceTask(sql, {
      libraryId, kind: 'embed-cover', scope: album, subjectId: album, queue: 'files.embedCover', input, stage: 'Queued',
    });
    return { track, folder, input, task };
  }
  const ctxOf = () => ({ sql: connection.client, db: connection.db, logger: pino({ level: 'silent' }), boss: { send: async () => null } as never });
  const temps = async (folder: string) => (await readdir(folder)).filter((n) => n.startsWith('.tagave-tmp-'));

  it('removes the temp copy a cut-off embed left beside the file, and only that one', async () => {
    const { track, folder, input, task } = await freshAlbum('Cut embed');
    const stale = path.join(folder, `${tempPrefixFor(track)}${randomUUID()}.flac`);
    const other = path.join(folder, `${tempPrefixFor(path.join(folder, 'other.flac'))}${randomUUID()}.flac`);
    await copyFile(track, stale);
    await copyFile(track, other);
    await embedCoverJob(ctxOf(), { ...input, maintenance: { taskId: task.id, attemptId: task.attempt_id } });
    expect(await connection.client`select state from maintenance_tasks where id = ${task.id}`).toEqual([{ state: 'done' }]);
    expect((await parseFile(track)).common.picture).toHaveLength(1);
    expect(await temps(folder)).toEqual([path.basename(other)]);
  });

  it('checks the folder again right before the rename: a failed check leaves the original and no temp copy', async () => {
    const { track, folder, input, task } = await freshAlbum('Checked embed');
    const before = await hashAudioStream(track, 'flac');
    const sql = connection.client;
    // tag writes go off while the helper prepares the temp copy: the check before the rename sees it
    class FlipGate extends FileGate {
      override async run<T>(root: string, op: GateOp, opts?: { probe?: boolean }): Promise<T> {
        const out = await super.run<T>(root, op, opts);
        if (op.op === 'prepareCover') await sql`update libraries set settings = '{"tagWritesEnabled":false}' where id = ${libraryId}`;
        return out;
      }
    }
    const flip = new FlipGate();
    setFileGate(flip);
    try {
      await embedCoverJob(ctxOf(), { ...input, maintenance: { taskId: task.id, attemptId: task.attempt_id } });
    } finally {
      setFileGate(null);
      await flip.close();
      await sql`update libraries set settings = '{"tagWritesEnabled":true}' where id = ${libraryId}`;
    }
    expect(await sql`select state, error from maintenance_tasks where id = ${task.id}`)
      .toEqual([{ state: 'failed', error: expect.stringContaining('The music folder changed or is read-only.') }]);
    expect((await parseFile(track)).common.picture).toBeUndefined();
    expect(await hashAudioStream(track, 'flac')).toBe(before);
    expect(await temps(folder)).toEqual([]);
  });
});

/**
 * Deleting songs and albums on the file worker (0073): moves into the root's
 * .tagave-trash by rename only, its .ndignore, Restore (and its refusal when
 * the old place is taken), Empty trash and the 30-day run, a read-only folder
 * falling back to a mark, and the scan: a trashed file is no loss, a marked
 * file the owner deleted is dropped at once (no hold), with its album.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, chmod, lstat, rename, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { cancelMaintenanceTask, makeDb, saveMaintenanceTask } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkTree } from './walk.js';
import { finishWalk } from './scanFinish.js';
import { emptyTrash, filesTrashJob, moveWaiting, restoreWaiting, trashDay } from './deletions.js';
import { setFileGate, type GateOp, type RunOptions } from './fileGate.js';
import { FolderOfflineError } from './folderOffline.js';
import { OutageGate } from '../testkit/outageGate.js';

const there = (p: string) => access(p).then(() => true, () => false);

describe.skipIf(!process.env.TEST_DATABASE_URL)('deletions on the file worker (db)', () => {
  let ctx: WorkerContext;
  let sql: any;
  let rootPath: string;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const sent: Array<{ name: string; data: unknown }> = [];
  const root = () => ({ id: rootId, libraryId, path: rootPath });

  /** An album folder with tracks, indexed as a scan would leave it (files, an album, its tracks). */
  async function album(dir: string, names: string[]): Promise<{ albumId: string; files: Record<string, string>; tracks: Record<string, string> }> {
    await mkdir(path.join(rootPath, dir), { recursive: true });
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, dir_paths, track_count)
              values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, ${dir}, 'Artist', 'matched', ${[dir]}, ${names.length})`;
    const files: Record<string, string> = {};
    const tracks: Record<string, string> = {};
    let n = 1;
    for (const name of names) {
      const rel = `${dir}/${name}`;
      await writeFile(path.join(rootPath, rel), `audio ${rel}`);
      const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler, last_seen_at)
                            values (${libraryId}, ${rootId}, ${rel}, 10, 1, 'present', 'audio', now() - interval '1 hour') returning id::text as id`;
      const [t] = await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin)
                            values (${albumId}, ${f.id}, ${n++}, ${name}, 'file') returning id::text as id`;
      files[name] = f.id;
      tracks[name] = t.id;
    }
    return { albumId, files, tracks };
  }

  const deleteFiles = async (kind: 'mark' | 'trash', fileIds: string[]) => {
    for (const id of fileIds) {
      const [f] = await sql`select rel_path from files where id = ${id}`;
      await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, created_by)
                values (${id}, ${libraryId}, ${rootId}, ${kind}, ${kind === 'mark' ? 'marked' : 'moving'}, ${f.rel_path}, ${userId})`;
    }
  };
  const row = async (fileId: string) => (await sql`select * from file_deletions where file_id = ${fileId}`)[0];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    const boss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`del-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'Del', ${userId}, '{}')`;
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-deletions-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, ${rootPath}, 'del', 'ok', true, true)`;
  });

  afterAll(async () => {
    await chmod(rootPath, 0o755).catch(() => undefined);
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('moves a file into <root>/.tagave-trash/<day>/<path>, with a .ndignore, by rename', async () => {
    const a = await album('Artist/Album One', ['01 One.flac', '02 Two.flac']);
    await deleteFiles('trash', [a.files['01 One.flac']!]);
    const out = await moveWaiting(ctx, libraryId, new Date('2026-11-02T10:00:00Z'));
    expect(out).toEqual({ trashed: 1, marked: 0, dropped: 0 });
    const r = await row(a.files['01 One.flac']!);
    expect(r).toMatchObject({ kind: 'trash', state: 'trashed', trash_rel_path: '.tagave-trash/2026-11-02/Artist/Album One/01 One.flac', error: null });
    expect(await there(path.join(rootPath, 'Artist/Album One/01 One.flac'))).toBe(false);
    expect(await readFile(path.join(rootPath, r.trash_rel_path), 'utf8')).toBe('audio Artist/Album One/01 One.flac');
    expect(await there(path.join(rootPath, '.tagave-trash/.ndignore'))).toBe(true);
    // the file row and its track stay (Restore loses nothing)
    expect((await sql`select count(*)::int as n from local_tracks where id = ${a.tracks['01 One.flac']!}`)[0].n).toBe(1);
  });

  it('a scan does not count a trashed file as gone, and never walks the trash', async () => {
    const w = await walkTree(ctx, root(), { mode: 'full' });
    expect(w.unseen.map((u) => u.relPath)).toContain('Artist/Album One/01 One.flac');
    const f = await finishWalk(ctx, root(), w);
    expect(f.missing).toBe(0);
    const [file] = await sql`select status from files where rel_path = 'Artist/Album One/01 One.flac' and scan_root_id = ${rootId}`;
    expect(file.status).toBe('present');
    expect((await sql`select count(*)::int as n from files where scan_root_id = ${rootId} and rel_path like '.tagave-trash%'`)[0].n).toBe(0);
  });

  it('restores to the old place; refuses while another file is there', async () => {
    const [{ file_id: id }] = await sql`select file_id from file_deletions where library_id = ${libraryId} and state = 'trashed'`;
    const back = path.join(rootPath, 'Artist/Album One/01 One.flac');
    await writeFile(back, 'someone else');
    await sql`update file_deletions set state = 'restoring' where file_id = ${id}`;
    expect(await restoreWaiting(ctx, libraryId)).toEqual({ restored: 0, refused: 1, dropped: 0 });
    expect(await row(id)).toMatchObject({ state: 'trashed', error: 'Another file is in its place' });
    await rm(back);
    await sql`update file_deletions set state = 'restoring' where file_id = ${id}`;
    expect(await restoreWaiting(ctx, libraryId)).toEqual({ restored: 1, refused: 0, dropped: 0 });
    expect(await row(id)).toBeUndefined();
    expect(await readFile(back, 'utf8')).toBe('audio Artist/Album One/01 One.flac');
    // the emptied day folders go; the trash folder and its .ndignore stay
    expect(await there(path.join(rootPath, '.tagave-trash', trashDay(new Date('2026-11-02T10:00:00Z'))))).toBe(false);
    expect(await there(path.join(rootPath, '.tagave-trash/.ndignore'))).toBe(true);
    expect(sent.some((s) => s.name === 'facets.refresh')).toBe(true);
  });

  it('Empty trash deletes the files and drops their rows; an album left without tracks goes too', async () => {
    const a = await album('Artist/Album Two', ['01 A.flac', '02 B.flac']);
    await deleteFiles('trash', Object.values(a.files));
    await moveWaiting(ctx, libraryId);
    expect(await emptyTrash(ctx, libraryId)).toEqual({ deleted: 2, failed: 0 });
    expect((await sql`select count(*)::int as n from files where id = any(${Object.values(a.files)}::uuid[])`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from local_albums where id = ${a.albumId}`)[0].n).toBe(0);
    expect(await there(path.join(rootPath, '.tagave-trash', trashDay(new Date()), 'Artist/Album Two/01 A.flac'))).toBe(false);
  });

  it('the daily run deletes only what has been in the trash for 30 days', async () => {
    const a = await album('Artist/Album Three', ['01 Old.flac', '02 New.flac']);
    await deleteFiles('trash', Object.values(a.files));
    await moveWaiting(ctx, libraryId);
    await sql`update file_deletions set trashed_at = now() - interval '31 days' where file_id = ${a.files['01 Old.flac']!}`;
    const out = await filesTrashJob(ctx, { action: 'sweep', libraryId });
    expect(out['expired']).toEqual({ deleted: 1, failed: 0 });
    expect(await row(a.files['01 Old.flac']!)).toBeUndefined();
    expect(await row(a.files['02 New.flac']!)).toMatchObject({ state: 'trashed' });
    // the album keeps its other track and its counters follow
    expect((await sql`select track_count from local_albums where id = ${a.albumId}`)[0].track_count).toBe(1);
  });

  it('keeps the confirmed purge across a missing mount and an interrupted unlink', async () => {
    const a = await album('Artist/Purge', ['01 Confirmed.flac', '02 Confirmed.flac', '03 Later.flac']);
    const ids = Object.values(a.files);
    await deleteFiles('trash', ids);
    await moveWaiting(ctx, libraryId);
    const id = ids[0]!;
    const task = await saveMaintenanceTask(ctx.sql, {
      libraryId, kind: 'empty-trash', scope: 'trash', queue: 'files.trash',
      input: { fileIds: ids.slice(0, 2) }, stage: 'Empty Trash queued',
    });
    await sql`update file_deletions set purge_task_id = ${task.id}, trashed_at = now() - interval '31 days' where file_id = any(${ids.slice(0, 2)}::uuid[])`;
    expect(await filesTrashJob(ctx, { action: 'empty', libraryId })).toHaveProperty('skipped');
    expect((await filesTrashJob(ctx, { action: 'sweep', libraryId })).expired).toEqual({ deleted: 0, failed: 0 });

    const run = (attemptId: string) => filesTrashJob(ctx, { action: 'empty', libraryId, maintenance: { taskId: task.id, attemptId } });
    const offline = rootPath + '-offline';
    await rename(rootPath, offline);
    try {
      await run(task.attempt_id);
      expect((await sql`select state from maintenance_tasks where id = ${task.id}`)[0].state).toBe('failed');
      expect(await row(id)).toMatchObject({ state: 'trashed' });
    } finally {
      await rename(offline, rootPath);
    }

    const file = path.join(rootPath, (await row(id)).trash_rel_path);
    const info = await lstat(file);
    const { mountIdentity } = await import('./fileRecovery.js');
    const checkpoint = { index: 0, inFlight: {
      id, file, mount: await mountIdentity(rootId, rootPath),
      fingerprint: JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs]),
    } };
    await sql`update maintenance_tasks set checkpoint = ${JSON.stringify(checkpoint)}::text::jsonb where id = ${task.id}`;
    await rm(file);
    const stopped = await cancelMaintenanceTask(ctx.sql, libraryId, task.id);
    expect(stopped?.state).toBe('waiting');
    await run(stopped!.attempt_id);
    expect(await row(id)).toBeUndefined();
    expect(await row(ids[1]!)).toMatchObject({ state: 'trashed', purge_task_id: null });
    expect(await row(ids[2]!)).toMatchObject({ state: 'trashed' });
    expect((await sql`select state, progress from maintenance_tasks where id = ${task.id}`)[0]).toMatchObject({
      state: 'cancelled', progress: { done: 1, total: 2 },
    });
  });

  it('a folder it cannot write marks the file instead, with the reason', async () => {
    const a = await album('Artist/Read Only', ['01 Stay.flac']);
    await deleteFiles('trash', [a.files['01 Stay.flac']!]);
    await chmod(path.join(rootPath, 'Artist/Read Only'), 0o555);
    try {
      const out = await moveWaiting(ctx, libraryId);
      expect(out.marked).toBe(1);
    } finally {
      await chmod(path.join(rootPath, 'Artist/Read Only'), 0o755);
    }
    expect(await row(a.files['01 Stay.flac']!)).toMatchObject({ kind: 'mark', state: 'marked', error: 'The music folder is read-only' });
    expect(await there(path.join(rootPath, 'Artist/Read Only/01 Stay.flac'))).toBe(true);
  });

  it('a file it cannot look at (EACCES) is marked with the reason, never dropped, and the run goes on', async () => {
    const a = await album('Artist/Locked', ['01 Locked.flac']);
    const b = await album('Artist/Open', ['01 Open.flac']);
    await deleteFiles('trash', [a.files['01 Locked.flac']!, b.files['01 Open.flac']!]);
    await chmod(path.join(rootPath, 'Artist/Locked'), 0o000);
    let out: Awaited<ReturnType<typeof moveWaiting>>;
    try {
      out = await moveWaiting(ctx, libraryId);
    } finally {
      await chmod(path.join(rootPath, 'Artist/Locked'), 0o755);
    }
    expect(out).toMatchObject({ trashed: 1, marked: 1, dropped: 0 });
    expect(await row(a.files['01 Locked.flac']!)).toMatchObject({ kind: 'mark', state: 'marked', error: 'The music folder is not readable' });
    expect((await sql`select count(*)::int as n from files where id = ${a.files['01 Locked.flac']!}`)[0].n).toBe(1);
    expect(await there(path.join(rootPath, 'Artist/Locked/01 Locked.flac'))).toBe(true);
    expect(await row(b.files['01 Open.flac']!)).toMatchObject({ state: 'trashed' });
  });

  it('a share unmounted mid-run: the root is asked again before a gone reading, nothing is dropped', async () => {
    const otherId = randomUUID();
    const otherPath = await mkdtemp(path.join(tmpdir(), 'tagave-deletions-midrun-'));
    const stash = await mkdtemp(path.join(tmpdir(), 'tagave-deletions-stash-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${otherId}, ${libraryId}, ${otherPath}, 'share', 'ok', true, true)`;
    /** The real gate; after the first look into the root (the run's check), the share goes: its folder left empty. */
    class UnmountGate extends OutageGate {
      unmount: (() => Promise<void>) | null = null;
      override async run<T>(rootId: string, op: GateOp, opts?: RunOptions): Promise<T> {
        const out = await super.run<T>(rootId, op, opts);
        if (op.op === 'readdirPage' && rootId === otherId && this.unmount) {
          const go = this.unmount;
          this.unmount = null;
          await go();
        }
        return out;
      }
    }
    const gate = new UnmountGate();
    setFileGate(gate);
    try {
      const mk = async (rel: string, state: 'moving' | 'restoring', trashMount: string | null = null) => {
        const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler)
                              values (${libraryId}, ${otherId}, ${rel}, 10, 1, 'present', 'audio') returning id::text as id`;
        await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, trash_mount, created_by)
                  values (${f.id}, ${libraryId}, ${otherId}, 'trash', ${state}, ${rel},
                          ${state === 'restoring' ? `.tagave-trash/2026-11-02/${rel}` : null}, ${trashMount}, ${userId})`;
        return f.id as string;
      };
      await mkdir(path.join(otherPath, 'Share/Album'), { recursive: true });
      await writeFile(path.join(otherPath, 'Share/Album/01 A.flac'), 'audio A');
      await writeFile(path.join(otherPath, 'Share/Album/02 B.flac'), 'audio B');
      const moving = [await mk('Share/Album/01 A.flac', 'moving'), await mk('Share/Album/02 B.flac', 'moving')];
      gate.unmount = async () => { await rename(path.join(otherPath, 'Share'), path.join(stash, 'Share')); };
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ trashed: 0, dropped: 0, paused: 2 });
      for (const id of moving) expect(await row(id)).toMatchObject({ state: 'moving', error: null });
      expect((await sql`select count(*)::int as n from files where id = any(${moving}::uuid[])`)[0].n).toBe(2);
      await sql`delete from file_deletions where file_id = any(${moving}::uuid[])`;

      // Restore: the copies in the Trash, on the mount they went into, and the share goes mid-run
      const { mountIdentity } = await import('./fileRecovery.js');
      const mount = await mountIdentity(otherId, otherPath);
      const copy = path.join(otherPath, '.tagave-trash/2026-11-02/Share/Album/03 C.flac');
      await mkdir(path.dirname(copy), { recursive: true });
      await writeFile(path.join(otherPath, '.tagave-trash', '.ndignore'), '');
      await writeFile(copy, 'audio C');
      const restoring = await mk('Share/Album/03 C.flac', 'restoring', mount);
      gate.unmount = async () => { await rename(path.join(otherPath, '.tagave-trash'), path.join(stash, '.tagave-trash')); };
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ restored: 0, dropped: 0, paused: 1 });
      expect(await row(restoring)).toMatchObject({ state: 'restoring', error: null });
      expect((await sql`select count(*)::int as n from files where id = ${restoring}`)[0].n).toBe(1);

      // the share is back: Restore runs
      await rename(path.join(stash, '.tagave-trash'), path.join(otherPath, '.tagave-trash'));
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ restored: 1, dropped: 0 });
      expect(await readFile(path.join(otherPath, 'Share/Album/03 C.flac'), 'utf8')).toBe('audio C');
    } finally {
      setFileGate(null);
      await gate.close();
      await sql`delete from file_deletions where scan_root_id = ${otherId}`;
      await sql`delete from files where scan_root_id = ${otherId}`;
      await sql`delete from scan_roots where id = ${otherId}`;
      await rm(otherPath, { recursive: true, force: true });
      await rm(stash, { recursive: true, force: true });
    }
  });

  it('a marked file the owner deleted is dropped at the next scan, without the hold, and its album goes', async () => {
    const a = await album('Artist/Dupes', Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')} T.flac`));
    // other present files, so twelve lost ones would be over the hold threshold
    await deleteFiles('mark', Object.values(a.files));
    for (const name of Object.keys(a.files)) await rm(path.join(rootPath, 'Artist/Dupes', name));
    const w = await walkTree(ctx, root(), { mode: 'full' });
    const f = await finishWalk(ctx, root(), w);
    expect(f.heldMissing).toBeNull();
    expect(f.deletedDropped).toBe(12);
    expect(f.missing).toBe(0);
    expect((await sql`select count(*)::int as n from files where id = any(${Object.values(a.files)}::uuid[])`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from local_albums where id = ${a.albumId}`)[0].n).toBe(0);
  });

  it('a music folder not connected (empty, gone, or read unmounted) never reads its files as gone', async () => {
    // a second root: the share's mount point, left as an empty folder
    const otherId = randomUUID();
    const otherPath = await mkdtemp(path.join(tmpdir(), 'tagave-deletions-unmounted-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${otherId}, ${libraryId}, ${otherPath}, 'share', 'ok', true, true)`;
    try {
      const mk = async (rel: string, state: 'moving' | 'restoring', trashMount: string | null = null) => {
        const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler)
                              values (${libraryId}, ${otherId}, ${rel}, 10, 1, 'present', 'audio') returning id::text as id`;
        await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, trash_rel_path, trash_mount, created_by)
                  values (${f.id}, ${libraryId}, ${otherId}, 'trash', ${state}, ${rel},
                          ${state === 'restoring' ? `.tagave-trash/2026-11-02/${rel}` : null}, ${trashMount}, ${userId})`;
        return f.id as string;
      };
      const moving = await mk('Share/Album/01 A.flac', 'moving');
      const restoring = await mk('Share/Album/02 B.flac', 'restoring');
      const kept = async () => {
        expect(await row(moving)).toMatchObject({ state: 'moving', kind: 'trash', error: null });
        expect(await row(restoring)).toMatchObject({ state: 'restoring', error: null });
        expect((await sql`select count(*)::int as n from files where id = any(${[moving, restoring]}::uuid[])`)[0].n).toBe(2);
      };
      // the empty mount point (reach not read yet)
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      await kept();
      // the folder itself gone
      await rm(otherPath, { recursive: true, force: true });
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      await kept();
      // the watch reads it not connected, though something is in the folder
      await mkdir(path.join(otherPath, 'stray'), { recursive: true });
      await sql`update scan_roots set reach = 'unmounted', reach_reason = 'not_mounted' where id = ${otherId}`;
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ dropped: 0, paused: 1 });
      await kept();
      // connected again after a remount (Ruling R29): the trash copies were made on another mount identity
      await sql`update scan_roots set reach = 'online', reach_reason = null where id = ${otherId}`;
      const elsewhere = JSON.stringify(['/srv/tagave/other', 1, 2]);
      await sql`update file_deletions set trash_mount = ${elsewhere} where file_id = ${restoring}`;
      // its copy is here, in this root's Trash: restored
      const copy = path.join(otherPath, '.tagave-trash/2026-11-02/Share/Album/02 B.flac');
      await mkdir(path.dirname(copy), { recursive: true });
      await writeFile(path.join(otherPath, '.tagave-trash', '.ndignore'), '');
      await writeFile(copy, 'audio B');
      // its copy is not here, on another mount: back to trashed with the reason, never dropped
      const missingHere = await mk('Share/Album/03 C.flac', 'restoring', elsewhere);
      // its copy is not here, on the mount it went into: gone, as before
      const { mountIdentity } = await import('./fileRecovery.js');
      const reallyGone = await mk('Share/Album/04 D.flac', 'restoring', await mountIdentity(otherId, otherPath));
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ restored: 1, refused: 1, dropped: 1 });
      expect(await row(restoring)).toBeUndefined();
      expect(await readFile(path.join(otherPath, 'Share/Album/02 B.flac'), 'utf8')).toBe('audio B');
      expect(await row(missingHere)).toMatchObject({ state: 'trashed', error: 'The Trash copy was not found on this mount.' });
      expect((await sql`select count(*)::int as n from files where id = any(${[restoring, missingHere]}::uuid[])`)[0].n).toBe(2);
      expect((await sql`select count(*)::int as n from files where id = ${reallyGone}`)[0].n).toBe(0);
      // with the root connected and its own mount, a file that is really gone is dropped (as before)
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ dropped: 1 });
      expect(await row(moving)).toBeUndefined();
    } finally {
      await sql`delete from file_deletions where scan_root_id = ${otherId}`;
      await sql`delete from files where scan_root_id = ${otherId}`;
      await sql`delete from scan_roots where id = ${otherId}`;
      await rm(otherPath, { recursive: true, force: true });
    }
  });

  it('the daily sweep skips a music folder that is not online, quietly, and takes its rows up once it is back', async () => {
    const otherId = randomUUID();
    const otherPath = await mkdtemp(path.join(tmpdir(), 'tagave-deletions-offline-'));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable, reach, reach_reason)
              values (${otherId}, ${libraryId}, ${otherPath}, 'share', 'ok', true, true, 'offline', 'server_silent')`;
    try {
      await mkdir(path.join(otherPath, 'Share/Album'), { recursive: true });
      await writeFile(path.join(otherPath, 'Share/Album/01 A.flac'), 'audio');
      const [f] = await sql`insert into files (library_id, scan_root_id, rel_path, size_bytes, mtime, status, handler)
                            values (${libraryId}, ${otherId}, 'Share/Album/01 A.flac', 5, 1, 'present', 'audio') returning id::text as id`;
      await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, created_by)
                values (${f.id}, ${libraryId}, ${otherId}, 'trash', 'moving', 'Share/Album/01 A.flac', ${userId})`;
      const logged: string[] = [];
      const quiet = { ...ctx, logger: pino({ level: 'debug' }, { write: (line: string) => void logged.push(line) }) };
      for (const reach of ['offline', 'unmounted']) {
        await sql`update scan_roots set reach = ${reach} where id = ${otherId}`;
        const out = await filesTrashJob(quiet, { libraryId, action: 'sweep' }) as { moved: { paused?: number } };
        expect(out.moved.paused).toBeUndefined();
        expect(await row(f.id)).toMatchObject({ state: 'moving', error: null });
      }
      expect(logged.filter((l) => l.includes(otherId))).toEqual([]);
      // back online: the next sweep moves it into the trash
      await sql`update scan_roots set reach = 'online', reach_reason = null where id = ${otherId}`;
      await filesTrashJob(quiet, { libraryId, action: 'sweep' });
      expect(await row(f.id)).toMatchObject({ state: 'trashed' });
    } finally {
      await sql`delete from file_deletions where scan_root_id = ${otherId}`;
      await sql`delete from files where scan_root_id = ${otherId}`;
      await sql`delete from scan_roots where id = ${otherId}`;
      await rm(otherPath, { recursive: true, force: true });
    }
  });

  it('an offline music folder leaves every row waiting: nothing marked, dropped or failed', async () => {
    const a = await album('Artist/Outage', ['01 Wait.flac', '02 Wait.flac']);
    await deleteFiles('trash', [a.files['01 Wait.flac']!]);
    const gate = new OutageGate();
    setFileGate(gate);
    try {
      gate.down = true;
      expect(await moveWaiting(ctx, libraryId)).toEqual({ trashed: 0, marked: 0, dropped: 0, paused: 1 });
      expect(await row(a.files['01 Wait.flac']!)).toMatchObject({ kind: 'trash', state: 'moving', error: null });
      expect((await sql`select count(*)::int as n from files where id = ${a.files['01 Wait.flac']!}`)[0].n).toBe(1);
      // an import's Replace waits for the folder instead
      await expect(moveWaiting(ctx, libraryId, new Date(), { throwOffline: true })).rejects.toBeInstanceOf(FolderOfflineError);

      // the folder is back for the move into the trash, then away for Restore and Empty trash
      gate.up();
      expect(await moveWaiting(ctx, libraryId)).toMatchObject({ trashed: 1 });
      gate.down = true;
      expect(await emptyTrash(ctx, libraryId)).toEqual({ deleted: 0, failed: 0 });
      expect(await row(a.files['01 Wait.flac']!)).toMatchObject({ state: 'trashed', error: null });
      await sql`update file_deletions set state = 'restoring' where file_id = ${a.files['01 Wait.flac']!}`;
      expect(await restoreWaiting(ctx, libraryId)).toEqual({ restored: 0, refused: 0, dropped: 0, paused: 1 });
      expect(await row(a.files['01 Wait.flac']!)).toMatchObject({ state: 'restoring', error: null });
      gate.up();
      expect(await restoreWaiting(ctx, libraryId)).toMatchObject({ restored: 1 });
      expect(await there(path.join(rootPath, 'Artist/Outage/01 Wait.flac'))).toBe(true);
    } finally {
      setFileGate(null);
      await gate.close();
    }
  });

  it('a marked file still on disk stays marked and present', async () => {
    const a = await album('Artist/Kept', ['01 K.flac']);
    await deleteFiles('mark', [a.files['01 K.flac']!]);
    const f = await finishWalk(ctx, root(), await walkTree(ctx, root(), { mode: 'full' }));
    expect(f.deletedDropped).toBe(0);
    expect(await row(a.files['01 K.flac']!)).toMatchObject({ state: 'marked' });
  });
});

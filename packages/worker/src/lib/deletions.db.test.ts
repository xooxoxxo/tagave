/**
 * Deleting songs and albums on the file worker (0073): moves into the root's
 * .tagave-trash by rename only, its .ndignore, Restore (and its refusal when
 * the old place is taken), Empty trash and the 30-day run, a read-only folder
 * falling back to a mark, and the scan: a trashed file is no loss, a marked
 * file the owner deleted is dropped at once (no hold), with its album.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkTree } from './walk.js';
import { finishWalk } from './scanFinish.js';
import { emptyTrash, filesTrashJob, moveWaiting, restoreWaiting, trashDay } from './deletions.js';

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

  it('a marked file still on disk stays marked and present', async () => {
    const a = await album('Artist/Kept', ['01 K.flac']);
    await deleteFiles('mark', [a.files['01 K.flac']!]);
    const f = await finishWalk(ctx, root(), await walkTree(ctx, root(), { mode: 'full' }));
    expect(f.deletedDropped).toBe(0);
    expect(await row(a.files['01 K.flac']!)).toMatchObject({ state: 'marked' });
  });
});

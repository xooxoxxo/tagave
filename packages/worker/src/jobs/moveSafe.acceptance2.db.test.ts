/**
 * Move-safe scanning, release A acceptance, part 2: what must fall back
 * cleanly, what the guards stop, and the races and clocks. Where the spec says
 * a move keeps everything, the full invariant (expectKept with the path
 * mapping) is used; where it says doubt means doing nothing, the test pins the
 * exact "nothing happened" state.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, rename, rm, stat, readdir, chmod, writeFile, copyFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { makeLab, expectKept, expectedFiles, bumpDir, type Lab, type Snapshot } from '../testkit/moveLab.js';
import { writeFlac } from '../testkit/flac.js';
import { tagSnapshotOf } from '../lib/tagSnapshot.js';
import { walkTree } from '../lib/walk.js';
import { finishWalk, missingHold, UNMOUNTED_SKIP } from '../lib/scanFinish.js';
import { releaseExpiredHolds } from '../lib/clusterHold.js';
import { fileStateAfterWrite } from './tagsApply.js';
import { scanDirJob } from './scanDir.js';
import { scanRootJob } from './scanRoot.js';
import { clusterDirJob } from './clusterDir.js';

const DB = !!process.env.TEST_DATABASE_URL;
let lab: Lab | null = null;
const envMusicRoot = process.env['TAGAVE_MUSIC_ROOT'];
afterEach(async () => {
  vi.useRealTimers();
  if (envMusicRoot === undefined) delete process.env['TAGAVE_MUSIC_ROOT'];
  else process.env['TAGAVE_MUSIC_ROOT'] = envMusicRoot;
  await lab?.close(); lab = null;
});

async function oneAlbum(n = 3) {
  lab = await makeLab(1);
  await lab.album(0, 'Artist/Album One', n, { cover: true });
  await lab.scan(0);
  await lab.ownerData((await lab.albumIdOf(0, 'Artist/Album One/01 - Song 1.flac'))!);
  return lab;
}
const abs = (l: Lab, rel: string) => path.join(l.roots[0]!.path, rel);
const statusCounts = async (l: Lab) => Object.fromEntries((await l.sql`
  select status, count(*)::int as n from audio_files where library_id = ${l.libraryId} group by status`).map((r: any) => [r.status, r.n]));
const lastScan = async (l: Lab) => (await l.sql`
  select status, stats from scans where scan_root_id = ${l.roots[0]!.id} order by started_at desc limit 1`)[0];
const lastScanJob = async (l: Lab) => (await l.sql`
  select state, progress, error from job_runs where library_id = ${l.libraryId} and type = 'scan.root' order by created_at desc limit 1`)[0];
const tracksOf = async (l: Lab, relPath: string) => l.sql`
  select lt.id from local_tracks lt join audio_files af on af.id = lt.audio_file_id
   where af.rel_path = ${relPath} and af.library_id = ${l.libraryId}`;
const moveDir = (from: string, to: string) => [{ from: [0, from] as [number, string], to: [0, to] as [number, string] }];
type Image = { local_album_id: string; origin: string; sidecar_beside: string | null };
const sidecarImages = (s: Snapshot) => (s.owner['images'] as Image[]).filter((i) => i.origin === 'sidecar');

describe.skipIf(!DB)('move-safe acceptance, part 2', () => {
  it('tag write then move: Tier 1 still pairs (mtime stored in seconds)', async () => {
    const l = await oneAlbum();
    const f = 'Artist/Album One/01 - Song 1.flac';
    await writeFlac(abs(l, f), { title: 'Song 1 (Remaster)', artist: 'Artist', albumartist: 'Artist', album: 'Album One', track: 1, seconds: 61, padding: 30 });
    const [{ id }] = await l.sql`select id from audio_files where library_id = ${l.libraryId} and rel_path = ${f}`;
    // what tags.apply records after its write
    const after = fileStateAfterWrite(await stat(abs(l, f)), tagSnapshotOf(await parseFile(abs(l, f))), 'h');
    await l.sql`update audio_files set size_bytes = ${after.sizeBytes}, mtime = ${after.mtime}, inode = ${after.inode},
                  tags_raw = ${JSON.stringify(after.tagsRaw)}::jsonb, tags_digest = ${after.tagsDigest},
                  core_tags_digest = ${after.coreTagsDigest}, tags_read_at = ${after.tagsReadAt.toISOString()}::timestamptz,
                  audio_hash = ${after.audioHash}
                where id = ${id}`;
    await l.scan(0);                                             // the walk sees no change: nothing to re-parse
    expect((await lastScan(l)).stats).toMatchObject({ changed: 0, added: 0, missing: 0 });
    const before = await l.snapshot();
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Album One (Remaster)'));
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true, moves: moveDir('Artist/Album One', 'Artist/Album One (Remaster)') });
    expect((await lastScan(l)).stats).toMatchObject({ merged: 3, missing: 0, added: 0 });
  });

  it('move plus re-tag: no pairing, the old album stays as a ghost, nothing breaks', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    const oldAlbum = (await l.albumIdOf(0, 'Artist/Album One/01 - Song 1.flac'))!;
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Renamed'));
    for (const name of await readdir(abs(l, 'Artist/Renamed'))) {
      if (!name.endsWith('.flac')) continue;
      const n = Number(name.slice(0, 2));
      await writeFlac(abs(l, `Artist/Renamed/${name}`), { title: `New title ${n}`, artist: 'Artist', album: 'Renamed', track: n, seconds: 60 + n, padding: 99 });
    }
    await l.scan(0);
    expect(await statusCounts(l)).toEqual({ missing: 3, present: 3 });
    expect((await lastScan(l)).stats).toMatchObject({ merged: 0 });
    const after = await l.snapshot();
    // the old rows keep their ids and paths, now missing; the new files are new rows
    const oldIds = new Set(before.files.map((x) => x.id));
    expect(after.files.filter((x) => oldIds.has(x.id))).toEqual(before.files.map((x) => ({ ...x, status: 'missing' })));
    const fresh = after.files.filter((x) => !oldIds.has(x.id));
    expect(fresh.map((x) => x.relPath).sort()).toEqual(before.files.map((x) => x.relPath.replace('Artist/Album One/', 'Artist/Renamed/')).sort());
    expect(fresh.every((x) => x.status === 'present')).toBe(true);
    // the ghost keeps its tracks (release B lists and prunes it), and every owner row stays on it
    expect(after.tracks.filter((t) => t.albumId === oldAlbum)).toEqual(before.tracks);
    expect(after.albums.find((a) => a.id === oldAlbum)).toEqual(before.albums.find((a) => a.id === oldAlbum));
    expect(after.counts.albums).toBe(2);
    const newAlbum = after.albums.find((a) => a.id !== oldAlbum)!;
    expect(newAlbum.releaseId).toBeNull();
    expect(after.tracks.filter((t) => t.albumId === newAlbum.id)).toHaveLength(3);
    expect(after.tracks.filter((t) => t.albumId === newAlbum.id).every((t) => t.canonical === null)).toBe(true);
    const { images: imgBefore, ...ownerBefore } = before.owner;
    const { images: imgAfter, ...ownerAfter } = after.owner;
    expect(ownerAfter).toEqual(ownerBefore);                      // locks, match, listens, plan items, player map untouched
    // both covers stay on the ghost; its sidecar row is kept beside its missing files (Ruling 9)
    expect((imgAfter as Image[]).map((i) => ({ ...i, sidecar_beside: i.origin === 'sidecar' ? 'missing' : i.sidecar_beside })))
      .toEqual((imgBefore as Image[]).map((i) => ({ ...i, sidecar_beside: i.origin === 'sidecar' ? 'missing' : i.sidecar_beside })));
    expect(sidecarImages(after).map((i) => i.sidecar_beside)).toEqual(['missing']);
  });

  it('partial move: the album splits by the clustering rules, no track row is duplicated, ids kept', async () => {
    const l = await oneAlbum(6);
    const before = await l.snapshot();
    await mkdir(abs(l, 'Artist/Album One (bonus)'));
    for (const n of [4, 5, 6]) await rename(abs(l, `Artist/Album One/0${n} - Song ${n}.flac`), abs(l, `Artist/Album One (bonus)/0${n} - Song ${n}.flac`));
    await l.scan(0);
    const after = await l.snapshot();
    expect(after.files).toEqual(expectedFiles(before, [4, 5, 6].map((n) => ({
      from: [0, `Artist/Album One/0${n} - Song ${n}.flac`] as [number, string],
      to: [0, `Artist/Album One (bonus)/0${n} - Song ${n}.flac`] as [number, string],
    }))));
    expect(after.tracks.map((t) => t.id)).toEqual(before.tracks.map((t) => t.id));
    expect(after.tracks.map((t) => t.fileId)).toEqual(before.tracks.map((t) => t.fileId));
    expect(after.counts.tracks).toBe(before.counts.tracks);
    expect(new Set(after.tracks.map((t) => t.fileId)).size).toBe(after.counts.tracks);
    expect(new Set(after.tracks.map((t) => t.albumId)).size).toBe(2);
    // the tracks that stayed keep the album, its match and its canonical links
    const oldAlbum = before.tracks[0]!.albumId;
    const stayed = before.files.filter((f) => !/0[456] - /.test(f.relPath)).map((f) => f.id);
    for (const t of after.tracks.filter((x) => stayed.includes(x.fileId))) {
      expect(t).toEqual(before.tracks.find((b) => b.id === t.id));
    }
    expect(after.albums.find((a) => a.id === oldAlbum)).toEqual(before.albums.find((a) => a.id === oldAlbum));
  });

  it('deluxe replacing standard: a new album, not a move', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Artist/Album', 3, { album: 'Album' });
    await lab.scan(0);
    const oldAlbum = (await lab.albumIdOf(0, 'Artist/Album/01 - Song 1.flac'))!;
    const before = await lab.snapshot();
    await rename(abs(lab, 'Artist/Album'), abs(lab, 'Artist/Album (Deluxe)'));
    for (const n of [4, 5]) await writeFlac(abs(lab, `Artist/Album (Deluxe)/0${n} - Bonus ${n}.flac`), { title: `Bonus ${n}`, artist: 'Artist', album: 'Album', track: n, seconds: 90 });
    await lab.scan(0);
    expect(await statusCounts(lab)).toEqual({ missing: 3, present: 5 });
    expect(await lab.albumIdOf(0, 'Artist/Album (Deluxe)/01 - Song 1.flac')).not.toBe(oldAlbum);
    const s = await lastScan(lab);
    expect(s.stats).toMatchObject({ merged: 0 });
    expect(s.stats.possibleMoves).toBeGreaterThanOrEqual(1);
    // the old rows are untouched apart from going missing; the old album keeps its tracks
    const after = await lab.snapshot();
    const oldIds = new Set(before.files.map((x) => x.id));
    expect(after.files.filter((x) => oldIds.has(x.id))).toEqual(before.files.map((x) => ({ ...x, status: 'missing' })));
    expect(after.tracks.filter((t) => t.albumId === oldAlbum)).toEqual(before.tracks);
  });

  it('scan.dir during scan.root: the row scan.dir re-pointed is never marked missing by the root scan', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Album 1'));
    const root = { id: l.roots[0]!.id, libraryId: l.libraryId, path: l.roots[0]!.path };
    const walk = await walkTree(l.ctx, root, { mode: 'full' });   // the root scan's walk, finish not run yet
    expect(walk.unseen).toHaveLength(3);
    await scanDirJob(l.ctx, { scanRootId: root.id, dirPath: 'Artist' }); // pairs and re-points meanwhile
    const f = await finishWalk(l.ctx, root, walk);
    expect(f.missing).toBe(0);
    expect(f.merged).toBe(0);                                     // nothing re-pointed twice
    await l.drain();
    expectKept(before, await l.snapshot(), { mapRebuilt: true, moves: moveDir('Artist/Album One', 'Artist/Album 1') });
  });

  it.skipIf(process.getuid?.() === 0)('a walk with a failed directory marks nothing under it missing; reconcile still runs elsewhere', async () => {
    const l = await oneAlbum();
    await l.album(0, 'Keep/Other', 1);                            // F3: the root yields files, so it does not look unmounted
    await l.scan(0);
    const before = await l.snapshot();
    await rename(abs(l, 'Keep/Other'), abs(l, 'Keep/Other (2020)')); // a move outside the failed folder, in the same scan
    await chmod(abs(l, 'Artist/Album One'), 0o000);
    try {
      await l.scan(0);
      expect(await statusCounts(l)).toEqual({ present: 4 });
      const s = await lastScan(l);
      expect(s.stats).toMatchObject({ missing: 0, merged: 1, failedDirs: ['Artist/Album One'], heldMissing: null, reconcileSkipped: null });
      const job = await lastScanJob(l);
      expect(job.state).toBe('completed');
      expect(job.progress.message).toMatch(/; could not read Artist\/Album One; nothing under them was marked missing$/);
      // the move outside merged with everything kept; the unreadable album (and its cover) is untouched
      expectKept(before, await l.snapshot(), { moves: moveDir('Keep/Other', 'Keep/Other (2020)') });
      expect(sidecarImages(await l.snapshot()).map((i) => i.sidecar_beside)).toEqual(['present']);
    } finally {
      await chmod(abs(l, 'Artist/Album One'), 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)('unmounted-looking root: aborts with the exact message, failed folder named, nothing marked or matched', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Album 1'));  // a real move, which must not be matched either
    await chmod(abs(l, 'Artist/Album 1'), 0o000);
    try {
      await l.scan(0);
      const expected = 'root yielded zero files but previously had files — treating as unmounted, nothing marked missing'
        + '; could not read Artist/Album 1; nothing under them was marked missing'
        + '; ' + UNMOUNTED_SKIP;
      expect(UNMOUNTED_SKIP).toBe('the root looks unmounted, so moved files are not matched in this scan');
      const s = await lastScan(l);
      expect(s.status).toBe('aborted');
      expect(s.stats.error).toBe(expected);
      const job = await lastScanJob(l);
      expect(job).toMatchObject({ state: 'failed', error: expected });
      expect(await statusCounts(l)).toEqual({ present: 3 });
      const after = await l.snapshot();
      expect(after).toEqual(before);                              // nothing paired, nothing missing, no row added
      expect(l.sent.filter((j) => j.name === 'scan.parse' || j.name === 'cluster.dir')).toEqual([]);
    } finally {
      await chmod(abs(l, 'Artist/Album 1'), 0o755);
    }
  });

  it('more than the threshold going missing in one scan is held, then confirmed', async () => {
    // the 500 cap: unit-level (a db fixture of 2,500 files is too big for the shared test database)
    expect(missingHold(501, 100_000)).toEqual({ held: true, threshold: 500 });
    expect(missingHold(500, 100_000)).toEqual({ held: false, threshold: 500 });
    lab = await makeLab(1);
    await lab.album(0, 'Big/A', 12, { cover: true });
    await lab.album(0, 'Big/B', 12);
    await lab.scan(0);
    const before = await lab.snapshot();
    await rm(abs(lab, 'Big/A'), { recursive: true });
    await lab.scan(0);
    expect(await statusCounts(lab)).toEqual({ present: 24 });
    const s = await lastScan(lab);
    expect(s.stats.heldMissing).toEqual({ count: 12, threshold: 10 });
    expect(s.stats.missing).toBe(0);
    expect((await lastScanJob(lab)).progress.message)
      .toMatch(/; looks partly unmounted: 12 files would go missing \(more than 10\), so none were marked$/);
    expect(await lab.snapshot()).toEqual(before);                 // held: nothing changed, the sidecar row (folder.jpg) kept too
    expect(await lab.sql`select 1 from sidecar_files where scan_root_id = ${lab.roots[0]!.id} and rel_path = 'Big/A/folder.jpg'`).toHaveLength(1);
    // a quick scan does not forget the hold
    await lab.scan(0, 'quick');
    expect(await statusCounts(lab)).toEqual({ present: 24 });
    expect((await lastScan(lab)).stats.heldMissing).toEqual({ count: 12, threshold: 10 });
    await lab.scan(0, 'full', { confirmMissing: true });
    expect(await statusCounts(lab)).toEqual({ present: 12, missing: 12 });
    const c = await lastScan(lab);
    expect(c.stats).toMatchObject({ missing: 12, heldMissing: null });
  });

  it('quick-mode move keeps everything', async () => {
    const l = await oneAlbum();
    await l.scan(0, 'quick');
    const before = await l.snapshot();
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Album 01'));
    await bumpDir(abs(l, 'Artist'));
    await l.scan(0, 'quick');
    expect((await lastScan(l)).stats).toMatchObject({ mode: 'quick', merged: 3, missing: 0 });
    expectKept(before, await l.snapshot(), { mapRebuilt: true, moves: moveDir('Artist/Album One', 'Artist/Album 01') });
  });

  it('a held cluster job is released after a parse error, and the folder is clustered', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Old', 1);
    await lab.scan(0);
    const st = await stat(abs(lab, 'Old/01 - Song 1.flac'));
    await rm(abs(lab, 'Old'), { recursive: true });
    await mkdir(abs(lab, 'New'));
    await writeFile(abs(lab, 'New/x.flac'), Buffer.alloc(st.size)); // same size, not a FLAC
    await scanRootJob(lab.ctx, { scanRootId: lab.roots[0]!.id, mode: 'full' });
    const [h] = await lab.sql`select reconcile_hold_at from audio_files where library_id = ${lab.libraryId} and rel_path = 'New/x.flac'`;
    expect(h.reconcile_hold_at).not.toBeNull();                   // held: it may be Old's file
    await clusterDirJob(lab.ctx, { libraryId: lab.libraryId, scanRootId: lab.roots[0]!.id, dirPath: 'New' });
    expect(await tracksOf(lab, 'New/x.flac')).toHaveLength(0);    // a held folder is not clustered
    lab.sent.splice(0, lab.sent.length, ...lab.sent.filter((j) => j.name === 'scan.parse'));
    await lab.drain({ only: ['scan.parse'] });                    // parse fails, hold released
    const [r] = await lab.sql`select status, reconcile_hold_at from audio_files where library_id = ${lab.libraryId} and rel_path = 'New/x.flac'`;
    expect(r).toMatchObject({ status: 'error', reconcile_hold_at: null });
    expect(lab.sent.filter((j) => j.name === 'cluster.dir').map((j) => j.data.dirPath)).toContain('New');
    await lab.drain();
    expect(await tracksOf(lab, 'New/x.flac')).toHaveLength(1);
  });

  it('a held cluster job is released after the one-hour cap even when nothing was parsed', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Old', 1);
    await lab.scan(0);
    await mkdir(abs(lab, 'New'));
    await copyFile(abs(lab, 'Old/01 - Song 1.flac'), abs(lab, 'New/01 - Song 1.flac'));
    await utimes(abs(lab, 'New/01 - Song 1.flac'), Date.now() / 1000 + 900, Date.now() / 1000 + 900);
    await rm(abs(lab, 'Old'), { recursive: true });
    await scanRootJob(lab.ctx, { scanRootId: lab.roots[0]!.id, mode: 'full' });
    lab.sent.length = 0;                                          // the parse job is lost
    const held = await lab.sql`select id from audio_files where library_id = ${lab.libraryId} and reconcile_hold_at is not null`;
    expect(held).toHaveLength(1);
    // before the cap nothing is released
    expect(await releaseExpiredHolds(lab.ctx, { libraryId: lab.libraryId })).toBe(0);
    expect(lab.sent).toEqual([]);
    await lab.sql`update audio_files set reconcile_hold_at = now() - interval '61 minutes' where library_id = ${lab.libraryId} and reconcile_hold_at is not null`;
    expect(await releaseExpiredHolds(lab.ctx, { libraryId: lab.libraryId })).toBe(1);
    expect(lab.sent.map((s) => [s.name, s.data.dirPath])).toEqual([['cluster.dir', 'New']]);
    expect(await lab.sql`select 1 from audio_files where library_id = ${lab.libraryId} and reconcile_hold_at is not null`).toHaveLength(0);
    await lab.drain();
    expect(await tracksOf(lab, 'New/01 - Song 1.flac')).toHaveLength(1);
  });

  it('worker clock ahead of the database: nothing just seen is marked missing', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    await l.scan(0);
    vi.useRealTimers();
    expect(await statusCounts(l)).toEqual({ present: 3 });
    expectKept(before, await l.snapshot());
  });

  it('worker clock ahead of the database: a move is still paired, nothing marked missing', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    await rename(abs(l, 'Artist/Album One'), abs(l, 'Artist/Album One [FLAC]'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    await l.scan(0);
    vi.useRealTimers();
    expect(await statusCounts(l)).toEqual({ present: 3 });
    expectKept(before, await l.snapshot(), { mapRebuilt: true, moves: moveDir('Artist/Album One', 'Artist/Album One [FLAC]') });
  });

  it('plain-file re-cluster does not duplicate tracks (NULLS NOT DISTINCT)', async () => {
    const l = await oneAlbum();
    const before = await l.snapshot();
    const job = { libraryId: l.libraryId, scanRootId: l.roots[0]!.id, dirPath: 'Artist/Album One' };
    await Promise.all([clusterDirJob(l.ctx, job), clusterDirJob(l.ctx, job), clusterDirJob(l.ctx, job)]);
    const after = await l.snapshot();
    expect(after.counts.tracks).toBe(3);
    expect(after.tracks).toEqual(before.tracks);
    expect((await l.sql`select count(*)::int as n from local_tracks lt join audio_files af on af.id = lt.audio_file_id
                         where af.library_id = ${l.libraryId} and lt.cue_start_ms is null`)[0].n).toBe(3);
  });

  /*
   * The player map, Ruling 10 boundary. The worker never holds the player's
   * address or credentials: re-matching a song id happens in the app
   * (packages/api, on the next play, for tracks without a map row) and the
   * folder rescan is worked by the app from player_scan_requests. So this
   * test asserts exactly what release A promises on the worker side: the
   * moved tracks' map rows are deleted, the old and the new folder are
   * requested, one debounced player.scan is sent, and a track that did not
   * move keeps its row. The rebuild itself is the app's existing path.
   */
  it('player map after a move: moved rows dropped, old and new folders requested, unmoved rows kept', async () => {
    lab = await makeLab(1);
    process.env['TAGAVE_MUSIC_ROOT'] = path.dirname(lab.roots[0]!.path); // folders relative to the music root
    await lab.album(0, 'Artist/Album One', 3, { cover: true });
    await lab.album(0, 'Artist/Album Two', 2, { cover: true });
    await lab.scan(0);
    for (const d of ['Artist/Album One', 'Artist/Album Two']) await lab.ownerData((await lab.albumIdOf(0, `${d}/01 - Song 1.flac`))!);
    const before = await lab.snapshot();
    const movedAlbum = (await lab.albumIdOf(0, 'Artist/Album One/01 - Song 1.flac'))!;
    const movedTracks = before.tracks.filter((t) => t.albumId === movedAlbum).map((t) => t.id);
    const stayTracks = before.tracks.filter((t) => t.albumId !== movedAlbum).map((t) => t.id);
    lab.sent.length = 0;
    await rename(abs(lab, 'Artist/Album One'), abs(lab, 'Artist/Album One (2001)'));
    await lab.scan(0);
    const after = await lab.snapshot();
    expectKept(before, after, { mapRebuilt: true, moves: moveDir('Artist/Album One', 'Artist/Album One (2001)') });
    const mapped = (after.owner['playerMap'] as Array<{ local_track_id: string }>).map((r) => r.local_track_id);
    expect(mapped.sort()).toEqual([...stayTracks].sort());
    for (const id of movedTracks) expect(mapped).not.toContain(id);
    const rootName = path.basename(lab.roots[0]!.path);
    const folders = (await lab.sql`select folder from player_scan_requests where library_id = ${lab.libraryId} order by folder`).map((r: any) => r.folder);
    expect(folders).toEqual([`${rootName}/Artist/Album One`, `${rootName}/Artist/Album One (2001)`]);
    expect(lab.sent.filter((j) => j.name === 'player.scan').map((j) => j.data)).toEqual([{ libraryId: lab.libraryId }]);
    await lab.sql`delete from player_scan_requests where library_id = ${lab.libraryId}`;
  });
});

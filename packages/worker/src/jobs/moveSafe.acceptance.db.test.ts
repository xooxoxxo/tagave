/**
 * Move-safe scanning, release A acceptance (spec "Tests", release A), part 1.
 * Every move keeps file ids, album id, match, canonical links, track ids,
 * locks, embedded and sidecar cover, collection link, listens and the
 * tag-plan revert target; the player map is dropped and rebuilt; no row
 * count grows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { makeLab, expectKept, bumpDir, type Lab } from '../testkit/moveLab.js';

const DB = !!process.env.TEST_DATABASE_URL;
let lab: Lab | null = null;
afterEach(async () => { await lab?.close(); lab = null; });

async function seeded(rootCount = 1, dirs = ['Artist/Album One']) {
  lab = await makeLab(rootCount);
  for (const d of dirs) await lab.album(0, d, 3, { cover: true });
  await lab.scan(0);
  for (const d of dirs) await lab.ownerData((await lab.albumIdOf(0, `${d}/01 - Song 1.flac`))!);
  // the snapshot must carry both covers, or expectKept would not see a lost sidecar cover
  const images = (await lab.snapshot()).owner['images'] as Array<{ origin: string; sidecar_beside_album: boolean }>;
  expect(images.filter((i) => i.origin === 'sidecar' && i.sidecar_beside_album)).toHaveLength(dirs.length);
  expect(images.filter((i) => i.origin === 'embedded')).toHaveLength(dirs.length);
  return lab;
}

describe.skipIf(!DB)('move-safe acceptance, part 1', () => {
  it('rename a file', async () => {
    const l = await seeded();
    const before = await l.snapshot();
    const dir = path.join(l.roots[0]!.path, 'Artist', 'Album One');
    await rename(path.join(dir, '02 - Song 2.flac'), path.join(dir, '02 - Song Two.flac'));
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('rename an album folder', async () => {
    const l = await seeded();
    const before = await l.snapshot();
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[0]!.path, 'Artist', 'Album One (2001)'));
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
    const [a] = await l.sql`select dir_paths from local_albums where library_id = ${l.libraryId}`;
    expect(a.dir_paths).toEqual(['Artist/Album One (2001)']);
  });

  it('rename an artist folder with three albums', async () => {
    const l = await seeded(1, ['Artist/Album One', 'Artist/Album Two', 'Artist/Album Three']);
    const before = await l.snapshot();
    await rename(path.join(l.roots[0]!.path, 'Artist'), path.join(l.roots[0]!.path, 'The Artist'));
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('move a disc set', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Artist/Box/CD1', 3, { album: 'Box' });
    await lab.album(0, 'Artist/Box/CD2', 3, { album: 'Box', firstTrack: 4 });
    await lab.scan(0);
    await lab.ownerData((await lab.albumIdOf(0, 'Artist/Box/CD1/01 - Song 1.flac'))!);
    const before = await lab.snapshot();
    expect(before.counts.albums).toBe(1);
    await mkdir(path.join(lab.roots[0]!.path, 'Boxes'));
    await rename(path.join(lab.roots[0]!.path, 'Artist', 'Box'), path.join(lab.roots[0]!.path, 'Boxes', 'Box'));
    await lab.scan(0);
    expectKept(before, await lab.snapshot(), { mapRebuilt: true });
  });

  it('move to another root, source scanned first', async () => {
    const l = await seeded(2);
    await l.album(0, 'Keep/Other', 1); await l.scan(0);         // root 0 must not look unmounted
    const before = await l.snapshot();
    await mkdir(path.join(l.roots[1]!.path, 'Artist'), { recursive: true });
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[1]!.path, 'Artist', 'Album One'));
    await l.scan(0);
    await l.scan(1);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('move to another root, destination scanned (and clustered) first: absorbed while untouched', async () => {
    const l = await seeded(2);
    await l.album(0, 'Keep/Other', 1); await l.scan(0);
    const before = await l.snapshot();
    await mkdir(path.join(l.roots[1]!.path, 'Moved'), { recursive: true });
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[1]!.path, 'Moved', 'Album One'));
    await l.scan(1);                                              // a pending album appears on root 1
    expect((await l.snapshot()).counts.albums).toBe(before.counts.albums + 1);
    await l.scan(0);                                              // source goes missing: Repair-style merge
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('destination clustered first, then the owner locked the new album: falls back, nothing merged', async () => {
    const l = await seeded(2);
    await l.album(0, 'Keep/Other', 1); await l.scan(0);
    await mkdir(path.join(l.roots[1]!.path, 'Moved'), { recursive: true });
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[1]!.path, 'Moved', 'Album One'));
    await l.scan(1);
    const fresh = (await l.albumIdOf(1, 'Moved/Album One/01 - Song 1.flac'))!;
    await l.sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${l.libraryId}, 'album', ${fresh}, 'year', ${l.userId})`;
    const mid = await l.snapshot();
    await l.scan(0);
    const after = await l.snapshot();
    expect(after.albums.map((a) => a.id)).toEqual(mid.albums.map((a) => a.id));
    const [old] = await l.sql`select count(*)::int as n from audio_files where scan_root_id = ${l.roots[0]!.id} and status = 'missing'`;
    expect(old.n).toBe(3);
    const [job] = await l.sql`select progress from job_runs where library_id = ${l.libraryId} and type = 'scan.root' order by created_at desc limit 1`;
    expect(job.progress.message).toMatch(/possible move/);
  });

  it('copy with reset mtime: Tier 2 pairs it, also when cluster.dir ran before Tier 2', async () => {
    const l = await seeded();
    const before = await l.snapshot();
    const src = path.join(l.roots[0]!.path, 'Artist', 'Album One');
    const dst = path.join(l.roots[0]!.path, 'Artist', 'Album One copy');
    await mkdir(dst);
    const { readdir, copyFile, utimes, rm } = await import('node:fs/promises');
    for (const f of await readdir(src)) {
      await copyFile(path.join(src, f), path.join(dst, f));
      await utimes(path.join(dst, f), Date.now() / 1000 + 900, Date.now() / 1000 + 900);
    }
    await rm(src, { recursive: true });
    await scanRootOnly(l);                                       // walk + finish, jobs not drained yet
    expect((await l.sql`select count(*)::int as n from audio_files where library_id = ${l.libraryId} and reconcile_hold_at is not null`)[0].n).toBe(3);
    await l.sql`update audio_files set reconcile_hold_at = now() - interval '2 hours' where library_id = ${l.libraryId} and reconcile_hold_at is not null`;
    // the hold is past its cap, so cluster.dir runs on the still unparsed rows first (loose track rows)
    const { clusterDirJob } = await import('./clusterDir.js');
    await clusterDirJob(l.ctx, { libraryId: l.libraryId, scanRootId: l.roots[0]!.id, dirPath: 'Artist/Album One copy' });
    await l.drain();                                             // parse → Tier 2 (absorb) → re-cluster
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('two identical files: no pairing, listed as a possible move', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'A/One', 1);
    await lab.scan(0);
    const { copyFile, stat, utimes, rm } = await import('node:fs/promises');
    const f = path.join(lab.roots[0]!.path, 'A', 'One', '01 - Song 1.flac');
    const st = await stat(f);
    for (const d of ['B', 'C']) {
      await mkdir(path.join(lab.roots[0]!.path, d));
      await copyFile(f, path.join(lab.roots[0]!.path, d, '01 - Song 1.flac'));
      await utimes(path.join(lab.roots[0]!.path, d, '01 - Song 1.flac'), st.atime, st.mtime);
    }
    await rm(path.join(lab.roots[0]!.path, 'A'), { recursive: true });
    await lab.scan(0);
    const [s] = await lab.sql`select stats from scans where scan_root_id = ${lab.roots[0]!.id} order by started_at desc limit 1`;
    expect(s.stats).toMatchObject({ merged: 0 });
    expect(s.stats.possibleMoves).toBeGreaterThanOrEqual(1);
  });

  it('one ambiguous track inside a moved album: the folder pair settles it', async () => {
    lab = await makeLab(1);
    for (const d of ['X/One', 'X/Second']) {                    // different album name lengths: distinct file sizes
      await lab.album(0, d, 4, { album: d });
      const { writeFile, utimes } = await import('node:fs/promises');
      const s = path.join(lab.roots[0]!.path, d, '00 - silence.flac');
      await writeFile(s, Buffer.alloc(64));                     // same bytes, same name in both albums
      await utimes(s, 1_700_000_000, 1_700_000_000);
    }
    await lab.scan(0);
    const before = await lab.snapshot();
    await rename(path.join(lab.roots[0]!.path, 'X'), path.join(lab.roots[0]!.path, 'Y'));
    await lab.scan(0);
    expectKept(before, await lab.snapshot());
  });

  it('move an album that already had a missing track', async () => {
    const l = await seeded();
    const { rm } = await import('node:fs/promises');
    await rm(path.join(l.roots[0]!.path, 'Artist', 'Album One', '03 - Song 3.flac'));
    await l.scan(0);
    const before = await l.snapshot();
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[0]!.path, 'Artist', 'Album 1'));
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('same path on another root, destination scanned first: the copy clusters onto the old album, then merges', async () => {
    const l = await seeded(2);
    await l.album(0, 'Keep/Other', 1); await l.scan(0);
    const before = await l.snapshot();
    const oldAlbum = (await l.albumIdOf(0, 'Artist/Album One/01 - Song 1.flac'))!;
    await mkdir(path.join(l.roots[1]!.path, 'Artist'), { recursive: true });
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[1]!.path, 'Artist', 'Album One'));
    await l.scan(1);                                              // same cluster key: no album of its own
    expect(await l.albumIdOf(1, 'Artist/Album One/01 - Song 1.flac')).toBe(oldAlbum);
    expect((await l.snapshot()).counts.albums).toBe(before.counts.albums);
    await l.scan(0);
    expectKept(before, await l.snapshot(), { mapRebuilt: true });
  });

  it('re-cluster after a fallback keeps the old album and its tracks', async () => {
    const l = await seeded(2);
    await l.album(0, 'Keep/Other', 1); await l.scan(0);
    const oldAlbum = (await l.albumIdOf(0, 'Artist/Album One/01 - Song 1.flac'))!;
    await mkdir(path.join(l.roots[1]!.path, 'Moved'), { recursive: true });
    await rename(path.join(l.roots[0]!.path, 'Artist', 'Album One'), path.join(l.roots[1]!.path, 'Moved', 'Album One'));
    await l.scan(1);
    const fresh = (await l.albumIdOf(1, 'Moved/Album One/01 - Song 1.flac'))!;
    await l.sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${l.libraryId}, 'album', ${fresh}, 'year', ${l.userId})`;
    await l.scan(0);                                              // falls back: the old rows go missing
    const mid = await l.snapshot();
    const { clusterDirJob } = await import('./clusterDir.js');
    await clusterDirJob(l.ctx, { libraryId: l.libraryId, scanRootId: l.roots[0]!.id, dirPath: 'Artist/Album One' });
    await clusterDirJob(l.ctx, { libraryId: l.libraryId, scanRootId: l.roots[1]!.id, dirPath: 'Moved/Album One' });
    await l.drain();
    await l.scan(1); await l.scan(0);
    const after = await l.snapshot();
    expect(after.albums).toEqual(mid.albums);
    expect(after.tracks).toEqual(mid.tracks);
    expect(after.owner).toEqual(mid.owner);
    expect(after.tracks.filter((t) => t.albumId === oldAlbum)).toHaveLength(3);
    expect(after.tracks.filter((t) => t.albumId === fresh)).toHaveLength(3);
  });
});

/** scan.root without draining what it queued. */
async function scanRootOnly(l: Lab) {
  const { scanRootJob } = await import('./scanRoot.js');
  await scanRootJob(l.ctx, { scanRootId: l.roots[0]!.id, mode: 'full' });
}

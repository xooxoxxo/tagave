/**
 * cluster.dir against a real database: the four multi-disc layouts must each
 * end up as ONE local album with a disc number per track, and re-clustering
 * from any member folder must land on the same cluster.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { clusterDirJob } from './clusterDir.js';

interface Tags {
  album?: string;
  albumartist?: string;
  artist?: string;
  title?: string;
  track?: number;
  disk?: number;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('clusterDirJob discs (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;

  const addFile = async (relPath: string, tags: Tags = {}): Promise<string> => {
    const id = randomUUID();
    await db.insert(audioFiles).values({
      id,
      libraryId,
      scanRootId: rootId,
      relPath,
      status: 'present',
      durationMs: 210_000,
      tagsRaw: {
        common: {
          ...(tags.album ? { album: tags.album } : {}),
          ...(tags.albumartist ? { albumartist: tags.albumartist } : {}),
          ...(tags.artist ? { artist: tags.artist } : {}),
          ...(tags.title ? { title: tags.title } : {}),
          ...(tags.track ? { track: { no: tags.track, of: null } } : {}),
          ...(tags.disk ? { disk: { no: tags.disk, of: null } } : {}),
        },
      },
    });
    return id;
  };

  const albums = async () =>
    db.select().from(localAlbums).where(eq(localAlbums.libraryId, libraryId));

  /** disc/track per file basename, for the one album the test expects. */
  const trackRows = async (albumId: string) => {
    const rows = (await client`
      select af.rel_path, lt.disc_no, lt.track_no, lt.title_guess
      from local_tracks lt join audio_files af on af.id = lt.audio_file_id
      where lt.local_album_id = ${albumId}
      order by coalesce(lt.disc_no, 1), lt.track_no`) as unknown as Array<{
      rel_path: string; disc_no: number | null; track_no: number | null; title_guess: string | null;
    }>;
    return rows;
  };

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    const boss = { send: async () => randomUUID() };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `discs-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Discs', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({
      id: rootId, libraryId, path: '/tmp/liner-discs-root', displayName: 'discs',
      validationStatus: 'ok', pollIntervalS: 3600,
    });
  });

  beforeEach(async () => {
    await db.delete(audioFiles).where(eq(audioFiles.scanRootId, rootId)); // cascades local_tracks
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  // Layout 1 — the owner's report: two sibling folders with a disc token,
  // no disc tag anywhere, previously two local albums both matched to a
  // one-disc release.
  const cd1 = 'R/Rammstein/2009 - Liebe ist fur alle da CD1';
  const cd2 = 'R/Rammstein/2009 - Liebe ist fur alle da CD2';
  const seedSiblingFolders = async () => {
    for (let i = 1; i <= 11; i += 1) {
      await addFile(`${cd1}/${String(i).padStart(2, '0')} - Song ${i}.flac`, {
        album: 'Liebe ist fur alle da', albumartist: 'Rammstein', artist: 'Rammstein',
        title: `Song ${i}`, track: i,
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      await addFile(`${cd2}/${String(i).padStart(2, '0')} - Bonus ${i}.flac`, {
        album: 'Liebe ist fur alle da', albumartist: 'Rammstein', artist: 'Rammstein',
        title: `Bonus ${i}`, track: i,
      });
    }
  };

  it('layout 1: sibling folders with a disc token become one two-disc album', async () => {
    await seedSiblingFolders();
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd1 });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    const album = rows[0]!;
    expect(album.discCount).toBe(2);
    expect(album.trackCount).toBe(16);
    expect([...album.dirPaths].sort()).toEqual([cd1, cd2]);
    expect(album.titleGuess).toBe('Liebe ist fur alle da');

    const tracks = await trackRows(album.id);
    expect(tracks).toHaveLength(16);
    expect(tracks.filter((t) => t.disc_no === 1)).toHaveLength(11);
    expect(tracks.filter((t) => t.disc_no === 2)).toHaveLength(5);
    expect(tracks.find((t) => t.rel_path === `${cd2}/03 - Bonus 3.flac`))
      .toMatchObject({ disc_no: 2, track_no: 3 });
  });

  it('layout 1: re-clustering from the other sibling yields the same cluster', async () => {
    await seedSiblingFolders();
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd1 });
    const first = (await albums())[0]!;

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd2 });
    const after = await albums();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first.id);
    expect(after[0]!.clusterKey).toBe(first.clusterKey);
    expect(await trackRows(after[0]!.id)).toHaveLength(16);
  });

  it('layout 1: retires the superseded per-folder clusters, matched ones included', async () => {
    await seedSiblingFolders();
    // The state the bug left behind: one 'matched' cluster per folder, both
    // pointing at the same one-disc release.
    const files = await db.select().from(audioFiles).where(eq(audioFiles.scanRootId, rootId));
    for (const [dir, state] of [[cd1, 'matched'], [cd2, 'matched']] as const) {
      const [old] = await db.insert(localAlbums).values({
        libraryId, clusterKey: `stale-${dir}`, dirPaths: [dir], state,
        titleGuess: 'Liebe ist fur alle da', discCount: 1,
      }).returning({ id: localAlbums.id });
      await db.insert(localTracks).values(
        files.filter((f: any) => f.relPath.startsWith(dir + '/'))
          .map((f: any) => ({ localAlbumId: old.id, audioFileId: f.id, state: 'matched' })),
      );
    }
    expect(await albums()).toHaveLength(2);

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd2 });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(2);
    expect(rows[0]!.clusterKey).not.toMatch(/^stale-/);
  });

  it('layout 2: a lone folder whose tags say disk 2 keeps disc 2 on its tracks', async () => {
    const dir = 'H/Have a Nice Life/Deathconsciousness The Future';
    for (let i = 1; i <= 6; i += 1) {
      await addFile(`${dir}/${String(i).padStart(2, '0')}.flac`, {
        album: 'Deathconsciousness', albumartist: 'Have a Nice Life',
        title: `Part ${i}`, track: i, disk: 2,
      });
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    // One distinct disc number, so still a one-disc cluster — but every track
    // knows it is disc 2, which is what the matcher needs.
    expect(rows[0]!.discCount).toBe(1);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks).toHaveLength(6);
    expect(tracks.every((t) => t.disc_no === 2)).toBe(true);
    expect(tracks.map((t) => t.track_no)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('layout 3: n-tt filename prefixes number the discs inside one folder', async () => {
    const dir = 'D/Dream Theater/Score 20th Anniversary World Tour';
    const tags = { album: 'Score', albumartist: 'Dream Theater' };
    // Disc 1 carries no prefix at all — the box set qualifies on discs 2 and 3,
    // and its unnumbered files are written out as disc 1 of the set.
    await addFile(`${dir}/01 - The Root Of All Evil.mp3`, tags);
    await addFile(`${dir}/02 - I Walk Beside You.mp3`, tags);
    await addFile(`${dir}/2-01 - Sacrificed Sons.mp3`, tags);
    await addFile(`${dir}/2-02 - Octavarium.mp3`, tags);
    await addFile(`${dir}/3-01 - Six Degrees.mp3`, tags);
    await addFile(`${dir}/3-02 - Metropolis.mp3`, tags);

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(3);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks.map((t) => [t.rel_path.slice(dir.length + 1), t.disc_no, t.track_no])).toEqual([
      ['01 - The Root Of All Evil.mp3', 1, 1],
      ['02 - I Walk Beside You.mp3', 1, 2],
      ['2-01 - Sacrificed Sons.mp3', 2, 1],
      ['2-02 - Octavarium.mp3', 2, 2],
      ['3-01 - Six Degrees.mp3', 3, 1],
      ['3-02 - Metropolis.mp3', 3, 2],
    ]);
    expect(tracks.find((t) => t.track_no === 1 && t.disc_no === 2)!.title_guess).toBe('Sacrificed Sons');
  });

  it('layout 3: a per-disc numbered "1-01…/2-01…" set becomes two discs', async () => {
    const dir = 'V/VA/2008 - Cafe del Mar';
    const tags = { album: 'Cafe del Mar', albumartist: 'Various Artists' };
    for (let i = 1; i <= 12; i += 1) await addFile(`${dir}/1-${String(i).padStart(2, '0')} - a${i}.mp3`, tags);
    for (let i = 1; i <= 8; i += 1) await addFile(`${dir}/2-${String(i).padStart(2, '0')} - b${i}.mp3`, tags);

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(2);
    expect(rows[0]!.trackCount).toBe(20);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks.filter((t) => t.disc_no === 1)).toHaveLength(12);
    expect(tracks.filter((t) => t.disc_no === 2)).toHaveLength(8);
    expect(tracks.filter((t) => t.disc_no === 2).map((t) => t.track_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('layout 3: "n-nn" filenames that just repeat the track number are one disc', async () => {
    // prod: A/Angels & Airwaves/2006 - We Don't Need To Whisper. The shipped
    // rule fabricated ten one-track discs out of a ten-track album.
    const dir = "A/Angels & Airwaves/2006 - We Don't Need To Whisper";
    const tags = { album: "We Don't Need To Whisper", albumartist: 'Angels & Airwaves' };
    await addFile(`${dir}/01 - Valkyrie Missle.mp3`, tags);
    for (const [n, title] of [
      [2, 'Distraction'], [3, 'Do It For Me Now'], [4, 'The Adventure'], [5, "A Little's Enough"],
      [6, 'The War'], [7, 'The Gift'], [8, 'It Hurts'], [9, 'Good Day'], [10, 'Start The Machine'],
    ] as const) {
      await addFile(`${dir}/${n}-${String(n).padStart(2, '0')} - ${title}.mp3`, tags);
    }

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(1);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks).toHaveLength(10);
    expect(tracks.every((t) => t.disc_no === null)).toBe(true);
    // The track number still comes out of the prefix, as it always did.
    expect(tracks.map((t) => t.track_no).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('layout 4 (already working): bare CD1/CD2 subfolders stay one album from either side', async () => {
    const base = 'T/Tool/Salival';
    for (const [disc, dir] of [[1, `${base}/CD1`], [2, `${base}/CD2`]] as const) {
      for (let i = 1; i <= 3; i += 1) {
        await addFile(`${dir}/${String(i).padStart(2, '0')} - t${disc}${i}.flac`, {
          album: 'Salival', albumartist: 'Tool', title: `t${disc}${i}`, track: i,
        });
      }
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `${base}/CD1` });
    const first = await albums();
    expect(first).toHaveLength(1);
    expect(first[0]!.discCount).toBe(2);
    expect([...first[0]!.dirPaths].sort()).toEqual([`${base}/CD1`, `${base}/CD2`]);

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `${base}/CD2` });
    const after = await albums();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first[0]!.id);
    const tracks = await trackRows(after[0]!.id);
    expect(tracks.filter((t) => t.disc_no === 1)).toHaveLength(3);
    expect(tracks.filter((t) => t.disc_no === 2)).toHaveLength(3);
  });

  it('merges sibling folders that sit at the top of the scan root', async () => {
    for (const disc of [1, 2]) {
      for (let i = 1; i <= 2; i += 1) {
        await addFile(`Top Album (Disc ${disc})/${String(i).padStart(2, '0')} - t.flac`, {
          album: 'Top Album', albumartist: 'Someone', track: i,
        });
      }
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Top Album (Disc 2)' });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(2);
    expect([...rows[0]!.dirPaths].sort()).toEqual(['Top Album (Disc 1)', 'Top Album (Disc 2)']);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks.map((t) => t.disc_no)).toEqual([1, 1, 2, 2]);
  });

  it('does not fold "Vol. n" siblings that are separate albums into one', async () => {
    // prod: "Guardians of Hellenism, Vol. 2" … "Vol. 14" — fourteen albums of a
    // series under one artist. Merging on the token made them one cluster of
    // fourteen folders. A "Vol. n" folder is its own scope, and carries no disc
    // number of its own either.
    for (const vol of [2, 3]) {
      for (let i = 1; i <= 3; i += 1) {
        await addFile(`M/DJ/Mixtape Vol. ${vol}/${String(i).padStart(2, '0')} - v${vol}t${i}.mp3`, {
          album: `Mixtape Vol. ${vol}`, albumartist: 'DJ', title: `v${vol}t${i}`, track: i,
        });
      }
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'M/DJ/Mixtape Vol. 2' });
    expect(await albums()).toHaveLength(1);
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'M/DJ/Mixtape Vol. 3' });

    const rows = await albums();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.discCount)).toEqual([1, 1]);
    expect(rows.map((r: any) => r.dirPaths[0]).sort())
      .toEqual(['M/DJ/Mixtape Vol. 2', 'M/DJ/Mixtape Vol. 3']);
    for (const r of rows) {
      expect(r.dirPaths).toHaveLength(1);
      expect((await trackRows(r.id)).every((t) => t.disc_no === null)).toBe(true);
    }
  });

  it('does not fold "Vol. n" siblings even when their album tag is the series name', async () => {
    for (const vol of [1, 2]) {
      for (let i = 1; i <= 3; i += 1) {
        await addFile(`W/White Fence/2012 - Family Perfume Vol. ${vol}/0${i} - t.mp3`, {
          album: 'Family Perfume', albumartist: 'White Fence', track: i,
        });
      }
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'W/White Fence/2012 - Family Perfume Vol. 1' });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'W/White Fence/2012 - Family Perfume Vol. 2' });

    const rows = await albums();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.dirPaths).toHaveLength(1);
  });

  // C3 — the "Album/CD1", "Album/CD2" layout where the album TAG carries the
  // token too. prod: "_OST/Final fantasy VI - Orignal Sound Version" with tags
  // "… [Disc 1]", "… CD2", "… (Disc 3)" — three clusters instead of one.
  const ffvi = '_OST/Final fantasy VI - Orignal Sound Version';
  const seedTaggedDiscSubfolders = async () => {
    const titles = ['Final Fantasy VI Original Sound Version [Disc 1]',
      'Final Fantasy VI Original Sound Version CD2',
      'Final Fantasy VI Original Sound Version (Disc 3)'];
    for (const [i, album] of titles.entries()) {
      for (let t = 1; t <= 3; t += 1) {
        await addFile(`${ffvi}/CD ${i + 1}/${String(t).padStart(2, '0')} - d${i + 1}t${t}.mp3`, {
          album, albumartist: 'Nobuo Uematsu', title: `d${i + 1}t${t}`, track: t,
        });
      }
    }
  };

  it('layout 5: disc subfolders whose album tags carry the token are one album', async () => {
    await seedTaggedDiscSubfolders();
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `${ffvi}/CD 1` });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(3);
    expect(rows[0]!.trackCount).toBe(9);
    expect(rows[0]!.titleGuess).toBe('Final Fantasy VI Original Sound Version');
    expect([...rows[0]!.dirPaths].sort()).toEqual([`${ffvi}/CD 1`, `${ffvi}/CD 2`, `${ffvi}/CD 3`]);
    const tracks = await trackRows(rows[0]!.id);
    expect(tracks.filter((t) => t.disc_no === 2)).toHaveLength(3);
  });

  it('layout 5: the same cluster whichever directory triggers the job', async () => {
    await seedTaggedDiscSubfolders();
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `${ffvi}/CD 2` });
    const first = (await albums())[0]!;
    // The parent scope itself, and the third disc — all three entry points must
    // agree on the album key, or each produces its own cluster_key.
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: ffvi });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `${ffvi}/CD 3` });

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.clusterKey).toBe(first.clusterKey);
    expect(await trackRows(rows[0]!.id)).toHaveLength(9);
  });

  it('an ordinary single-folder album keeps a disc token in its title', async () => {
    // The token only comes off when the scope actually spans discs; a lone
    // folder tagged "… Disc 2" is still that album.
    const dir = 'H/Have a Nice Life/Deathconsciousness';
    for (let i = 1; i <= 3; i += 1) {
      await addFile(`${dir}/0${i} - t.flac`, { album: 'Deathconsciousness Disc 2', albumartist: 'Have a Nice Life', track: i });
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.titleGuess).toBe('Deathconsciousness Disc 2');
  });

  // C6 — two sibling folders of one album can be clustered at the same time.
  it('concurrent sibling jobs upsert one album, never two', async () => {
    await seedSiblingFolders();
    await Promise.all([
      clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd1 }),
      clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd2 }),
    ]);

    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.discCount).toBe(2);
    expect(await trackRows(rows[0]!.id)).toHaveLength(16);
  });

  it('the upsert keeps the album id and state across re-clusters', async () => {
    await seedSiblingFolders();
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd1 });
    const first = (await albums())[0]!;
    await client`update local_albums set state = 'matched' where id = ${first.id}`;

    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: cd2 });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.state).toBe('matched');
    expect(new Date(rows[0]!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());
  });
});

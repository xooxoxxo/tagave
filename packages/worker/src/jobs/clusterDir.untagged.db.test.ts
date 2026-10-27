/**
 * Files without album tags form an album per folder, titled after the folder
 * and listed in Library care as "No album tags" (QA 2026-10-26 Q-05). And a
 * scan that makes a new album queues identification at once, through one
 * throttled identify.sweep top-up, instead of waiting for the five-minute
 * schedule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeLab, bumpDir } from '../testkit/moveLab.js';
import { writeFlac } from '../testkit/flac.js';
import { clusterDirJob, folderTitle } from './clusterDir.js';
import { gapsRecomputeJob } from './gapsRecompute.js';

describe('folderTitle', () => {
  it('reads underscores as spaces only in a name without spaces', () => {
    expect(folderTitle('bjork_homogenic')).toBe('bjork homogenic');
    expect(folderTitle('Live at the BBC_2')).toBe('Live at the BBC_2');
    expect(folderTitle('  Odd   spacing ')).toBe('Odd spacing');
    expect(folderTitle('')).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('albums without album tags (db)', () => {
  let lab: Awaited<ReturnType<typeof makeLab>> | null = null;
  afterEach(async () => { await lab?.close(); lab = null; });

  const albumsOf = async (l: NonNullable<typeof lab>) => l.sql`
    select la.id, la.title_guess, la.artist_guess, la.state, count(lt.id)::int as tracks
      from local_albums la left join local_tracks lt on lt.local_album_id = la.id
     where la.library_id = ${l.libraryId}
     group by la.id order by la.title_guess`;
  const sweeps = (l: NonNullable<typeof lab>) => l.sent.filter((j) => j.name === 'identify.sweep');
  const noTagsFlags = async (l: NonNullable<typeof lab>) => l.sql`
    select subject_id from gaps
     where library_id = ${l.libraryId} and kind = 'quality' and flag = 'noAlbumTags' and state = 'open'`;

  it('a title-only file is in exactly one album, listed in Attention; a rescan adds nothing', async () => {
    lab = await makeLab(1);
    const dir = path.join(lab.roots[0]!.path, 'misc', 'bjork_homogenic');
    await mkdir(dir, { recursive: true });
    await writeFlac(path.join(dir, 'track03.flac'), { title: 'Unravel', seconds: 201 });
    await lab.scan(0);

    const albums = await albumsOf(lab);
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ title_guess: 'bjork homogenic', artist_guess: null, state: 'pending', tracks: 1 });
    const loose = await lab.sql`
      select count(*)::int as n from local_tracks lt join files af on af.id = lt.audio_file_id
       where af.library_id = ${lab.libraryId} and lt.local_album_id is null`;
    expect(loose[0].n).toBe(0);

    await gapsRecomputeJob(lab.ctx, { libraryId: lab.libraryId });
    expect((await noTagsFlags(lab)).map((r: any) => r.subject_id)).toEqual([albums[0].id]);

    // identification is queued by the scan, not left to the schedule
    expect(sweeps(lab)).toHaveLength(1);
    expect(sweeps(lab)[0]).toMatchObject({
      data: { libraryId: lab.libraryId, topUp: true },
      opts: { singletonKey: `identify.sweep:${lab.libraryId}`, singletonSeconds: 30, singletonNextSlot: true },
    });

    // a rescan and a re-cluster of the same folder keep the one album and queue nothing
    lab.sent.length = 0;
    await lab.scan(0);
    await clusterDirJob(lab.ctx, { libraryId: lab.libraryId, scanRootId: lab.roots[0]!.id, dirPath: 'misc/bjork_homogenic' });
    const again = await albumsOf(lab);
    expect(again.map((a: any) => [a.id, a.tracks])).toEqual([[albums[0].id, 1]]);
    expect(sweeps(lab)).toHaveLength(0);
  });

  it('a folder with one tagged album: an untagged file joins it', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Artist/Mixed', 2, { album: 'Real Album', artist: 'Artist' });
    await writeFlac(path.join(lab.roots[0]!.path, 'Artist', 'Mixed', 'bonus.flac'), { title: 'Bonus', artist: 'Artist', seconds: 90 });
    await lab.scan(0);

    const albums = await albumsOf(lab);
    expect(albums.map((a: any) => [a.title_guess, a.artist_guess, a.tracks])).toEqual([['Real Album', 'Artist', 3]]);
    await gapsRecomputeJob(lab.ctx, { libraryId: lab.libraryId });
    expect(await noTagsFlags(lab)).toHaveLength(0);
    expect(sweeps(lab)).toHaveLength(1);
  });

  it('an untagged file naming another artist, or two tagged albums: a folder album of its own', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'Other', 1, { album: 'Real Album', artist: 'Artist' });
    await writeFlac(path.join(lab.roots[0]!.path, 'Other', 'x.flac'), { title: 'X', artist: 'Someone Else', seconds: 90 });
    await lab.album(0, 'Two', 1, { album: 'First', artist: 'Artist' });
    await writeFlac(path.join(lab.roots[0]!.path, 'Two', '09 - b.flac'), { title: 'B', album: 'Second', artist: 'Artist', track: 9, seconds: 70 });
    await writeFlac(path.join(lab.roots[0]!.path, 'Two', 'bonus.flac'), { title: 'Bonus', seconds: 90 });
    await lab.scan(0);

    const albums = await albumsOf(lab);
    expect(albums.map((a: any) => [a.title_guess, a.artist_guess, a.tracks])).toEqual([
      ['First', 'Artist', 1],
      ['Other', 'Someone Else', 1],
      ['Real Album', 'Artist', 1],
      ['Second', 'Artist', 1],
      ['Two', null, 1],
    ]);
    await gapsRecomputeJob(lab.ctx, { libraryId: lab.libraryId });
    const ids = albums.filter((a: any) => a.title_guess === 'Other' || a.title_guess === 'Two').map((a: any) => a.id).sort();
    expect((await noTagsFlags(lab)).map((r: any) => r.subject_id).sort()).toEqual(ids);
    // one send per folder that made an album, all on the one throttled key
    expect(new Set(sweeps(lab).map((j) => j.opts.singletonKey))).toEqual(new Set([`identify.sweep:${lab.libraryId}`]));
  });

  it('a file without a duration stays loose', async () => {
    lab = await makeLab(1);
    const dir = path.join(lab.roots[0]!.path, 'Broken');
    await mkdir(dir);
    await writeFlac(path.join(dir, 'empty.flac'), { title: 'Empty', seconds: 0 });
    await lab.scan(0);
    expect(await albumsOf(lab)).toHaveLength(0);
  });

  it('a new folder on a later scan queues identification; tagging the files keeps the album', async () => {
    lab = await makeLab(1);
    await lab.album(0, 'A/One', 1);
    await lab.scan(0);
    lab.sent.length = 0;

    const dir = path.join(lab.roots[0]!.path, 'Loose_Folder');
    await mkdir(dir);
    await writeFlac(path.join(dir, '01.flac'), { title: 'One', artist: 'Somebody', seconds: 120, padding: 40 });
    await lab.scan(0);
    expect(sweeps(lab)).toHaveLength(1);
    const before = (await albumsOf(lab)).find((a: any) => a.title_guess === 'Loose Folder');
    expect(before).toMatchObject({ artist_guess: 'Somebody', tracks: 1 });

    // identify gave up for want of tags; the owner then tags the file
    await lab.sql`update local_albums set state = 'unidentified', identify_reason = 'no_tags', last_identify_at = now() where id = ${before.id}`;
    lab.sent.length = 0;
    await writeFlac(path.join(dir, '01.flac'), { title: 'One', artist: 'Somebody', album: 'Proper Title', seconds: 120, padding: 41 });
    await bumpDir(dir);
    await lab.scan(0, 'quick');
    const after = (await albumsOf(lab)).filter((a: any) => a.title_guess !== 'One');
    expect(after.map((a: any) => [a.id, a.title_guess, a.state])).toEqual([[before.id, 'Proper Title', 'pending']]);
    // not held by the sweep's 6 h retry rule
    const [la] = await lab.sql`select last_identify_at from local_albums where id = ${before.id}`;
    expect(la.last_identify_at).toBeNull();
    // the album was re-keyed, not created: the scheduled sweep picks it up
    expect(sweeps(lab)).toHaveLength(0);
  });
});

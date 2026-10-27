/**
 * cluster.backfillLoose: loose untagged files left by the clusterer before
 * QA 2026-10-26 Q-05 get their folder album after one run; a second run
 * finds nothing to send.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeLab } from '../testkit/moveLab.js';
import { writeFlac } from '../testkit/flac.js';
import { clusterBackfillLooseJob } from './clusterBackfillLoose.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('cluster.backfillLoose (db)', () => {
  let lab: Awaited<ReturnType<typeof makeLab>> | null = null;
  afterEach(async () => { await lab?.close(); lab = null; });

  it('re-clusters the folders of loose files once, paced, and then finds nothing', async () => {
    lab = await makeLab(1);
    const l = lab;
    for (const d of ['Old_One', 'Old_Two']) {
      await mkdir(path.join(l.roots[0]!.path, d));
      await writeFlac(path.join(l.roots[0]!.path, d, 'a.flac'), { title: 'A', seconds: 100, padding: 20 + d.length });
    }
    await l.album(0, 'Tagged', 1);
    await l.scan(0);
    // the state the old clusterer left: track rows with no album
    const mine = l.sql`select af.id from files af where af.library_id = ${l.libraryId} and af.rel_path like 'Old%'`;
    await l.sql`update local_tracks set local_album_id = null where audio_file_id in (${mine})`;
    await l.sql`delete from local_albums la where la.library_id = ${l.libraryId}
                 and not exists (select 1 from local_tracks lt where lt.local_album_id = la.id)`;
    expect((await l.sql`select count(*)::int as n from local_albums where library_id = ${l.libraryId}`)[0].n).toBe(1);

    l.sent.length = 0;
    // other test files share the database: only this lab's roots count
    const r = await clusterBackfillLooseJob(l.ctx, { perSlot: 1, slotSeconds: 5, limit: 100_000 });
    const ours = l.sent.filter((j) => j.name === 'cluster.dir' && j.data.libraryId === l.libraryId);
    expect(ours.map((j) => j.data.dirPath).sort()).toEqual(['Old_One', 'Old_Two']);
    expect(r.folders).toBeGreaterThanOrEqual(2);
    // staggered: one folder per slot here
    expect(new Set(ours.map((j) => j.opts.startAfter)).size).toBe(2);
    l.sent.splice(0, l.sent.length, ...ours);
    await l.drain();

    const albums = await l.sql`select title_guess from local_albums where library_id = ${l.libraryId} order by 1`;
    expect(albums.map((a: any) => a.title_guess)).toEqual(['Old One', 'Old Two', 'Tagged']);

    l.sent.length = 0;
    await clusterBackfillLooseJob(l.ctx, { limit: 100_000 });
    expect(l.sent.filter((j) => j.name === 'cluster.dir' && j.data.libraryId === l.libraryId)).toHaveLength(0);
  });

  it('stops at its limit and says more is left', async () => {
    lab = await makeLab(1);
    const l = lab;
    await mkdir(path.join(l.roots[0]!.path, 'Lone'));
    await writeFlac(path.join(l.roots[0]!.path, 'Lone', 'a.flac'), { title: 'A', seconds: 100 });
    await l.scan(0);
    await l.sql`update local_tracks set local_album_id = null where audio_file_id in
                (select id from files where library_id = ${l.libraryId})`;
    l.sent.length = 0;
    const r = await clusterBackfillLooseJob(l.ctx, { limit: 1 });
    expect(r.folders).toBe(1);
    expect(l.sent.filter((j) => j.name === 'cluster.dir')).toHaveLength(1);
  });
});

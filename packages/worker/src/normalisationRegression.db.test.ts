import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './lib/context.js';
import { regressionContext } from './barcodeRegression.js';
import { normalisationRegression, renderNormalisationReport, type NormalisationReport } from './normalisationRegression.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('normalisation regression report (db)', () => {
  let ctx: WorkerContext; let client: any;
  const user = randomUUID(); const lib = randomUUID(); const root = randomUUID(); const rg = randomUUID(); const rgLatin = randomUUID();
  const albumJa = randomUUID(); const albumLatin = randomUUID();
  let rightJa = ''; let wrongJa = '';
  let candidatesBefore: unknown[] = [];

  const jaTracks = ['朝の光', '海辺にて', '帰り道'];
  const otherTracks = ['雨の夜', '遠い街', '冬の星'];

  async function release(group: string, title: string, trackTitles: string[]) {
    const rel = randomUUID();
    await client`insert into releases (id, release_group_id, mbid, title, status, date, track_count, source_of_truth)
                 values (${rel}, ${group}, ${randomUUID()}, ${title}, 'Official', '2010-01-01', 3, 'musicbrainz')`;
    for (let i = 1; i <= 3; i++) {
      await client`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${rel}, 1, ${i}, ${trackTitles[i - 1]!}, ${200000 + i * 1000})`;
    }
    return rel;
  }

  async function album(id: string, title: string, artist: string, trackTitles: string[]) {
    await client`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, year_guess, state, track_count)
                 values (${id}, ${lib}, ${'k-' + id}, ${title}, ${artist}, 2011, 'needs_review', 3)`;
    for (let i = 1; i <= 3; i++) {
      const f = randomUUID();
      await client`insert into files (id, handler, library_id, scan_root_id, rel_path, size_bytes, mtime, status, tags_raw)
                   values (${f}, 'audio', ${lib}, ${root}, ${id + '/' + i + '.flac'}, 1, 1, 'present', ${JSON.stringify({ common: { title: trackTitles[i - 1] } })}::text::jsonb)`;
      await client`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, duration_ms) values (${id}, ${f}, ${i}, ${trackTitles[i - 1]!}, ${200000 + i * 1000})`;
    }
  }

  const candidate = (albumId: string, rel: string, distance: string) =>
    client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source) values (${albumId}, ${rel}, ${distance}, '{}'::jsonb, 'mb_search')`;

  let report: NormalisationReport;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email, password_hash) values (${user}, ${'nr-' + user + '@test.com'}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id, settings) values (${lib}, 'NR', ${user}, '{}'::jsonb)`;
    await client`insert into scan_roots (id, library_id, path, display_name, writable) values (${root}, ${lib}, ${'/nr-' + root}, 'NR', false)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, '夜明けの歌', '["山田花子"]'::jsonb)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rgLatin}, ${randomUUID()}, 'Lichtung', '["Ensemble Nord"]'::jsonb)`;
    // one Japanese album, two Japanese candidates with different titles and
    // tracks. The old normaliser read every title as empty, so both scored
    // the same and the wrong one came first by stored order.
    await album(albumJa, '夜明けの歌', '山田花子', jaTracks);
    rightJa = await release(rg, '夜明けの歌', jaTracks);
    wrongJa = await release(rg, '星空の街', otherTracks);
    await candidate(albumJa, wrongJa, '0.0100');
    await candidate(albumJa, rightJa, '0.0200');
    // a plain ASCII album the change cannot touch
    await album(albumLatin, 'Lichtung', 'Ensemble Nord', ['Song 1', 'Song 2', 'Song 3']);
    await candidate(albumLatin, await release(rgLatin, 'Lichtung', ['Song 1', 'Song 2', 'Song 3']), '0.0100');
    candidatesBefore = await client`select mc.* from match_candidates mc join local_albums la on la.id = mc.local_album_id where la.library_id = ${lib} order by mc.local_album_id, mc.release_id`;
    report = await normalisationRegression(ctx, { libraryId: lib });
  });
  afterAll(async () => {
    await client`delete from libraries where id = ${lib}`;
    await client`delete from releases where release_group_id = any(${[rg, rgLatin]}::uuid[])`;
    await client`delete from release_groups where id = any(${[rg, rgLatin]}::uuid[])`;
    await client`delete from users where id = ${user}`;
    await client.end({ timeout: 5 });
  });

  it('replays every album with stored candidates, unfiltered', () => {
    expect(report.albumsConsidered).toBe(2);
    expect(report.albumsCompared).toBe(2);
  });

  it('the old scorer could not tell the two Japanese titles apart; the current one picks the right one', () => {
    expect(report.rows.map((r) => r.albumId)).toEqual([albumJa]);
    const row = report.rows[0]!;
    expect(row.tiedBefore).toBe(true);
    expect(row.top.before.releaseId).toBe(wrongJa);
    expect(row.top.after.releaseId).toBe(rightJa);
    expect(row.top.after.distance).toBeLessThan(row.top.before.distance + 1e-9);
    expect(row.bucket).toEqual({ album: 'cjk', title: 'cjk', artist: 'cjk' });
    expect(report.topChanges).toBe(1);
  });

  it('counts the change in the cjk bucket and nowhere else', () => {
    expect(report.byBucket.cjk.albums).toBe(1);
    expect(report.byBucket.cjk.changed).toBe(1);
    expect(report.byBucket.cjk.topChanges).toBe(1);
    expect(report.byBucket['latin-ascii']).toEqual({ albums: 1, changed: 0, topChanges: 0, identifyChanges: 0, outcomeChanges: 0 });
    expect(report.byTitleBucket.cjk.changed).toBe(1);
    expect(report.byArtistBucket.cjk.changed).toBe(1);
  });

  it('gives the same answer page by page', async () => {
    expect(await normalisationRegression(ctx, { libraryId: lib, batchSize: 1 })).toEqual(report);
  });

  it('renders the cjk section with the album and no file paths', () => {
    const md = renderNormalisationReport(report);
    expect(md).toContain('## cjk (1)');
    expect(md).toContain(albumJa);
    expect(md).toContain('星空の街');
    expect(md).toContain('How to read this');
    expect(md).not.toContain('.flac');
    expect(md).not.toContain('/nr-');
  });

  it('runs on read-only connections and writes nothing', async () => {
    const { ctx: ro, close } = await regressionContext(process.env.TEST_DATABASE_URL!);
    try {
      const again = await normalisationRegression(ro, { libraryId: lib });
      expect(again.rows.map((r) => r.albumId)).toEqual([albumJa]);
    } finally { await close(); }
    const after = await client`select mc.* from match_candidates mc join local_albums la on la.id = mc.local_album_id where la.library_id = ${lib} order by mc.local_album_id, mc.release_id`;
    expect(after).toEqual(candidatesBefore);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './lib/context.js';
import { barcodeRegression, regressionContext, renderRegressionReport, type RegressionReport } from './barcodeRegression.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('barcode regression report (db)', () => {
  let ctx: WorkerContext; let client: any;
  const user = randomUUID(); const lib = randomUUID(); const root = randomUUID(); const rg = randomUUID();
  const albumHit = randomUUID(); const albumSame = randomUUID();
  const albumFormat = randomUUID(); const albumEmbedded = randomUUID(); const albumNotStored = randomUUID(); const albumIncomplete = randomUUID(); const albumNoTag = randomUUID();
  let incompleteRelease = ''; let hitRelease = '';
  let liveBefore: unknown[] = [];

  async function album(id: string, barcode: string | null, releaseBarcode: string | null, opts: { tracks?: boolean; breakdown?: object; tags?: object } = {}) {
    const rel = randomUUID();
    await client`insert into releases (id, release_group_id, mbid, title, status, date, barcode, track_count, source_of_truth)
                 values (${rel}, ${rg}, ${randomUUID()}, 'Lichtung', 'Official', '2011-01-01', ${releaseBarcode}, 3, 'musicbrainz')`;
    await client`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, year_guess, state, track_count)
                 values (${id}, ${lib}, ${'k-' + id}, 'Lichtung', 'Ensemble Nord', 2011, 'needs_review', 3)`;
    for (let i = 1; i <= 3; i++) {
      const f = randomUUID();
      const common = { ...(barcode ? { barcode } : {}), title: 'Song ' + i, ...(opts.tags ?? {}) };
      await client`insert into files (id, handler, library_id, scan_root_id, rel_path, size_bytes, mtime, status, tags_raw)
                   values (${f}, 'audio', ${lib}, ${root}, ${id + '/' + i + '.flac'}, 1, 1, 'present', ${JSON.stringify({ common })}::text::jsonb)`;
      await client`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, duration_ms) values (${id}, ${f}, ${i}, ${'Song ' + i}, ${200000 + i * 1000})`;
      if (opts.tracks !== false) {
        await client`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${rel}, 1, ${i}, ${'Song ' + i}, ${200000 + i * 1000})`;
      }
    }
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source) values (${id}, ${rel}, 0.0000, ${JSON.stringify(opts.breakdown ?? {})}::text::jsonb, 'mb_search')`;
    return rel;
  }

  let report: RegressionReport;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
    await client`insert into users (id, email, password_hash) values (${user}, ${'br-' + user + '@test.com'}, 'x')`;
    await client`insert into libraries (id, name, owner_user_id, settings) values (${lib}, 'BR', ${user}, '{}'::jsonb)`;
    await client`insert into scan_roots (id, library_id, path, display_name, writable) values (${root}, ${lib}, ${'/br-' + root}, 'BR', false)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Lichtung', '["Ensemble Nord"]'::jsonb)`;
    // mismatch: strong before, not strong after; its stored artist term differs from the rebuilt one
    hitRelease = await album(albumHit, '0123', '9999', { breakdown: { artist: 0.5 } });
    // matched automatically today
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason)
                 values (${lib}, ${albumHit}, ${hitRelease}, 0.0000, 'auto', 'system', 'auto-accept: test')`;
    await album(albumSame, '0123', '0123');  // match: unchanged
    await album(albumFormat, '012345678905', '0012345678905'); // UPC-A vs EAN-13: same barcode, written differently
    await album(albumNotStored, '0123', null); // the stored release never had a barcode
    incompleteRelease = await album(albumIncomplete, '0123', '9999', { tracks: false }); // no stored tracks
    await album(albumNoTag, null, '9999');     // the files carry no barcode
    // a matching barcode beside a mismatching embedded release id: the embedded
    // mismatch alone puts the distance past the review band, so nothing changes
    await album(albumEmbedded, '5555', '5555', { tags: { musicbrainz_albumid: randomUUID() } });
    liveBefore = await client`select am.* from album_matches am join local_albums la on la.id = am.local_album_id where la.library_id = ${lib} order by am.id`;
    report = await barcodeRegression(ctx, { libraryId: lib });
  });
  afterAll(async () => {
    await client`delete from libraries where id = ${lib}`;
    await client`delete from releases where release_group_id = ${rg}`;
    await client`delete from release_groups where id = ${rg}`;
    await client`delete from users where id = ${user}`;
    await client.end({ timeout: 5 });
  });

  it('lists the albums whose identify outcome the fix changes, and only those', async () => {
    expect(report.albumsCompared).toBe(4);
    expect(report.rows.map((r) => r.albumId)).toEqual([albumHit]);
    expect(report.rows[0]!.identify.before).toBe('strong');
    expect(report.rows[0]!.identify.after).not.toBe('strong');
    expect(report.rows[0]!.cause).toBe('mismatch');
    expect(report.rows[0]!.outcome.before).toBe('auto');
    expect(report.rows[0]!.artistDrift).toBe(true);
    expect(report.rows[0]!.live).toBe(true);
    expect(report.liveMatchAffected).toEqual([albumHit]);
    expect(Object.values(report.identifyChanges).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('honours a limit', async () => {
    const r = await barcodeRegression(ctx, { libraryId: lib, limit: 1 });
    expect(r.albumsConsidered).toBe(1);
  });

  it('gives the same answer page by page', async () => {
    const r = await barcodeRegression(ctx, { libraryId: lib, batchSize: 2 });
    expect(r.albumsConsidered).toBe(7);
    expect(r).toEqual(report);
  });

  it('splits candidates by how their barcodes compare', () => {
    expect(report.candidates).toEqual({ match: 2, format_only: 1, mismatch: 1, unusable: 0, not_stored: 1 });
  });

  it('puts unstored barcodes, files without one and releases without tracks in their own buckets', () => {
    expect(report.skipped.notStored).toBe(1);
    expect(report.skipped.noFileBarcode).toBe(1);
    expect(report.notReplayable).toEqual([{ albumId: albumIncomplete, title: 'Lichtung', artist: 'Ensemble Nord', releaseIds: [incompleteRelease] }]);
  });

  it('renders a report with titles and ids but no file paths', () => {
    const md = renderRegressionReport(report);
    expect(md).toContain(albumHit);
    expect(md).toContain('Lichtung');
    expect(md).toContain('was stored');
    expect(md).not.toContain('.flac');
    expect(md).not.toContain('/br-');
  });

  it('runs on read-only connections', async () => {
    const { ctx: ro, close } = await regressionContext(process.env.TEST_DATABASE_URL!);
    try {
      const shown = await ro.sql<Array<{ default_transaction_read_only: string }>>`show default_transaction_read_only`;
      expect(shown[0]!.default_transaction_read_only).toBe('on');
      await expect(ro.sql`insert into release_groups (id, mbid, title) values (${randomUUID()}, ${randomUUID()}, 'x')`).rejects.toThrow(/read-only/);
      const again = await barcodeRegression(ro, { libraryId: lib });
      expect(again.rows.map((r) => r.albumId)).toEqual([albumHit]);
    } finally { await close(); }
  });

  it('writes nothing', async () => {
    const liveAfter = await client`select am.* from album_matches am join local_albums la on la.id = am.local_album_id where la.library_id = ${lib} order by am.id`;
    expect(liveAfter).toEqual(liveBefore);
    expect(liveAfter).toHaveLength(1);
    const [{ d }] = await client`select max(distance)::text as d from match_candidates mc join local_albums la on la.id = mc.local_album_id where la.library_id = ${lib}`;
    expect(d).toBe('0.0000');
    const [{ s }] = await client`select count(*)::int as s from local_albums where library_id = ${lib} and state <> 'needs_review'`;
    expect(s).toBe(0);
  });
});

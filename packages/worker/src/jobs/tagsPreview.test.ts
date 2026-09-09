/**
 * tags.preview against a real database: a matched album with a canonical
 * release produces per-file diffs; unidentified files are skipped; the
 * policy never blanks a tag; previews do not duplicate rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  audioFiles, canonicalTracks, fieldLocks, libraries, localAlbums, localTracks,
  releaseGroups, releases, scanRoots, tagPlanItems, tagPlans, users, makeDb,
} from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { tagsPreviewJob, currentFieldsFrom, decideField, valueKey } from './tagsPreview.js';

describe('preview helpers', () => {
  it('maps music-metadata common tags to canonical fields', () => {
    const f = currentFieldsFrom({
      common: {
        title: 'Blooming Disaster', artist: 'Obscurus Advocam', album: 'Verbia Daemonicus', albumartist: 'Obscurus Advocam',
        year: 2007, genre: ['Black Metal'], track: { no: 6, of: null }, disk: { no: null, of: null },
        musicbrainz_trackid: 'rt-1', discogs_master_release_id: 123, compilation: true,
      },
    });
    expect(f).toMatchObject({
      title: 'Blooming Disaster', album: 'Verbia Daemonicus', date: '2007', genre: ['Black Metal'],
      tracknumber: '6', totaltracks: null, discnumber: null, musicbrainz_releasetrackid: 'rt-1',
      discogs_master_id: '123', compilation: '1', musicbrainz_albumid: null,
    });
  });

  it('compares arrays as sets and strings trimmed', () => {
    expect(valueKey(['b', 'a', 'a'])).toBe(valueKey(['a', 'b']));
    expect(valueKey(' x ')).toBe(valueKey('x'));
    expect(valueKey(null)).toBe(valueKey(''));
  });

  it('decides per policy and never blanks from missing canonical data', () => {
    expect(decideField('overwrite', 'old', 'new', false)).toEqual({ after: 'new', reason: 'policy:overwrite' });
    expect(decideField('overwrite', 'old', null, false).reason).toBe('no-change');
    expect(decideField('overwrite', 'same', 'same', false).reason).toBe('no-change');
    expect(decideField('fill', null, 'new', false)).toEqual({ after: 'new', reason: 'policy:fill' });
    expect(decideField('fill', 'kept', 'new', false).reason).toBe('no-change');
    expect(decideField('never', 'old', 'new', false).reason).toBe('no-change');
    expect(decideField('overwrite', 'old', 'new', true).reason).toBe('locked');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('tagsPreviewJob (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  let albumId: string;
  let releaseId: string;
  let releaseGroupId: string;
  let fileA: string;
  let fileB: string;
  let strayFile: string;
  let strayAlbum: string;
  let planId: string;
  const planIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `preview-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Preview', ownerUserId: userId, settings: { tagWritesEnabled: true } });
    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/preview-root', displayName: 'preview', writable: true, validationStatus: 'ok' });

    releaseGroupId = randomUUID();
    await db.insert(releaseGroups).values({
      id: releaseGroupId, mbid: 'rg-mbid-1', title: 'Canonical Album', primaryType: 'Album', firstReleaseDate: '1999-01-01',
      artistCredit: [{ name: 'Canon Artist', mbid: 'artist-mbid-1' }],
    });
    releaseId = randomUUID();
    await db.insert(releases).values({
      id: releaseId, releaseGroupId, mbid: 'rel-mbid-1', title: 'Canonical Album', date: '2001-05-05', country: 'GB', status: 'Official',
      trackCount: 2, labels: [{ name: 'Harvest', catalogNumber: 'SHVL 804' }], media: [{ position: 1, format: 'CD', trackCount: 2 }],
      tracksRefreshedAt: new Date(), // skip ensureTrackMbids fetch in tests
    });
    await db.insert(canonicalTracks).values([
      { releaseId, mediumNo: 1, position: 1, number: '1', title: 'Canon One', artistCredit: [{ name: 'Canon Artist', mbid: 'artist-mbid-1' }], recordingMbid: 'rec-mbid-1', trackMbid: 'track-mbid-1' },
      { releaseId, mediumNo: 1, position: 2, number: '2', title: 'Canon Two', artistCredit: [{ name: 'Canon Artist', mbid: 'artist-mbid-1' }], recordingMbid: 'rec-mbid-2', trackMbid: 'track-mbid-2' },
    ]);

    albumId = randomUUID();
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `prev-${albumId}`, dirPaths: ['Canon/Album'], titleGuess: 'Old Album', artistGuess: 'Canon Artist',
      state: 'matched', releaseId, releaseGroupId, trackCount: 2, discCount: 1, tracksLinkedAt: null,
    });
    fileA = randomUUID();
    fileB = randomUUID();
    await db.insert(audioFiles).values([
      {
        id: fileA, libraryId, scanRootId: rootId, relPath: 'Canon/Album/01.mp3', sizeBytes: 1, mtime: 1, status: 'present',
        tagsRaw: { common: { title: 'Old One', artist: 'Canon Artist', album: 'Old Album', track: { no: 1, of: null }, disk: { no: null, of: null }, barcode: 'KEEP-ME', genre: ['Rock'] } },
      },
      {
        id: fileB, libraryId, scanRootId: rootId, relPath: 'Canon/Album/02.mp3', sizeBytes: 1, mtime: 1, status: 'present',
        tagsRaw: { common: { title: '', album: 'Canonical Album', track: { no: 2, of: 2 }, disk: { no: 1, of: 1 }, musicbrainz_albumid: 'rel-mbid-1', musicbrainz_releasegroupid: 'rg-mbid-1', musicbrainz_albumartistid: ['artist-mbid-1'], musicbrainz_artistid: ['artist-mbid-1'], date: '2001-05-05', originaldate: '1999-01-01', label: ['Harvest'], catalognumber: ['SHVL 804'], media: 'CD', releasecountry: 'GB', releasestatus: 'Official', releasetype: ['Album'], albumartist: 'Canon Artist', albumartistsort: 'Canon Artist', artistsort: 'Canon Artist', artist: 'Canon Artist' } },
      },
    ]);
    await db.insert(localTracks).values([
      { localAlbumId: albumId, audioFileId: fileA, discNo: null, trackNo: 1, titleGuess: 'Old One' },
      { localAlbumId: albumId, audioFileId: fileB, discNo: 1, trackNo: 2, titleGuess: 'Two' },
    ]);

    // An album that identify has not matched yet
    strayAlbum = randomUUID();
    await db.insert(localAlbums).values({ id: strayAlbum, libraryId, clusterKey: `stray-${strayAlbum}`, dirPaths: ['Stray'], state: 'pending', trackCount: 1 });
    strayFile = randomUUID();
    await db.insert(audioFiles).values({ id: strayFile, libraryId, scanRootId: rootId, relPath: 'Stray/01.flac', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: { common: { title: 'Lost' } } });
    await db.insert(localTracks).values({ localAlbumId: strayAlbum, audioFileId: strayFile, trackNo: 1 });

    planId = randomUUID();
    planIds.push(planId);
    await db.insert(tagPlans).values({
      id: planId, libraryId, name: 'canonical ids + fill', scope: { type: 'albumIds', albumIds: [albumId, strayAlbum] },
      policy: { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' }, status: 'draft', stats: {}, createdBy: userId,
    });
  });

  afterAll(async () => {
    if (planIds.length) {
      for (const id of planIds) await db.delete(tagPlanItems).where(eq(tagPlanItems.tagPlanId, id));
      await db.delete(tagPlans).where(eq(tagPlans.libraryId, libraryId));
    }
    await db.delete(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, albumId));
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, strayAlbum));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, releaseId));
    await db.delete(releases).where(eq(releases.id, releaseId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, releaseGroupId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId)); // cascades audio files
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  const itemsOf = async (id: string) => db.select().from(tagPlanItems).where(eq(tagPlanItems.tagPlanId, id));
  const diffMap = (item: any) => Object.fromEntries((item.diff as any[]).map((d) => [d.field, d]));

  it('produces per-file diffs from the matched release and skips the unidentified album', async () => {
    await tagsPreviewJob(ctx, planId);
    const [plan] = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
    expect(plan.status).toBe('previewed');
    const stats = plan.stats as any;
    expect(stats.filesTouched).toBe(2); // both fileA and fileB have diffs now (with track mbids)
    expect(stats.filesSkipped).toEqual([{ audioFileId: strayFile, reason: 'audio_file_error', message: 'album not identified' }]);

    const items = await itemsOf(planId);
    expect(items).toHaveLength(2);
    const b = items.find((i: any) => i.audioFileId === fileB)!;
    const bDiffKeys = Object.keys(diffMap(b)).sort();
    expect(bDiffKeys).toEqual(['musicbrainz_recordingid', 'musicbrainz_releasetrackid', 'title']);
    expect(diffMap(b).title).toMatchObject({ before: null, after: 'Canon Two', reason: 'policy:fill' });
    expect(diffMap(b).musicbrainz_recordingid).toMatchObject({ before: null, after: 'rec-mbid-2', reason: 'policy:overwrite' });
    expect(diffMap(b).musicbrainz_releasetrackid).toMatchObject({ before: null, after: 'track-mbid-2', reason: 'policy:overwrite' });
    const a = items.find((i: any) => i.audioFileId === fileA)!;
    const d = diffMap(a);
    expect(d.musicbrainz_albumid).toMatchObject({ before: null, after: 'rel-mbid-1', reason: 'policy:overwrite' });
    expect(d.musicbrainz_releasegroupid.after).toBe('rg-mbid-1');
    expect(d.album).toMatchObject({ before: 'Old Album', after: 'Canonical Album', reason: 'policy:overwrite' });
    expect(d.totaltracks).toMatchObject({ before: null, after: '2' });
    expect(d.discnumber).toMatchObject({ before: null, after: '1' });
    expect(d.date.after).toBe('2001-05-05');
    expect(d.label.after).toBe('Harvest');
    expect(d.catalognumber.after).toBe('SHVL 804');
    // 0026: track mbids from canonical tracks linked by position
    expect(d.musicbrainz_recordingid).toMatchObject({ before: null, after: 'rec-mbid-1', reason: 'policy:overwrite' });
    expect(d.musicbrainz_releasetrackid).toMatchObject({ before: null, after: 'track-mbid-1', reason: 'policy:overwrite' });
    // fill: existing title stays, existing genre stays
    expect(d.title).toBeUndefined();
    expect(d.genre).toBeUndefined();
    // never blank from missing data: the release has no barcode, the file keeps its own
    expect(d.barcode).toBeUndefined();
    // tracknumber already 1 → no row
    expect(d.tracknumber).toBeUndefined();
    // fileA has more fields changed now (added mbids); fileB also has mbids now
    const aDiffCount = Object.keys(d).length;
    const bDiffCount = bDiffKeys.length;
    expect(stats.fieldsModified).toBe(aDiffCount + bDiffCount);
    // the journal's before is the canonical-field map, not raw music-metadata
    expect((a.before as any).album).toBe('Old Album');
    expect((a.before as any).common).toBeUndefined();
  });

  it('re-running the preview replaces rows instead of duplicating them', async () => {
    await tagsPreviewJob(ctx, planId);
    const items = await itemsOf(planId);
    expect(items).toHaveLength(2);
    expect(items.every((i: any) => i.status === 'pending')).toBe(true);
  });

  it('an album-level lock keeps the current value and is counted once per file it would have changed', async () => {
    await db.insert(fieldLocks).values({ libraryId, scope: 'album', scopeId: albumId, field: 'album', value: 'Old Album', reason: 'owner', createdBy: userId });
    await tagsPreviewJob(ctx, planId);
    const [plan] = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
    expect((plan.stats as any).lockedFieldsRespected).toBe(1); // file B's album already equals the lock value
    const a = (await itemsOf(planId)).find((i: any) => i.audioFileId === fileA)!;
    expect(diffMap(a).album).toBeUndefined();
    await db.delete(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
  });

  it('overwrite_all changes the title too; fill_blanks_only fills only empties', async () => {
    const all = randomUUID();
    const fill = randomUUID();
    planIds.push(all, fill);
    await db.insert(tagPlans).values([
      { id: all, libraryId, name: 'all', scope: { type: 'albumIds', albumIds: [albumId] }, policy: { preset: 'overwrite_all', id3Version: '2.4', multiValueSeparator: '; ' }, status: 'draft', stats: {}, createdBy: userId },
      { id: fill, libraryId, name: 'fill', scope: { type: 'albumIds', albumIds: [albumId] }, policy: { preset: 'fill_blanks_only', id3Version: '2.4', multiValueSeparator: '; ' }, status: 'draft', stats: {}, createdBy: userId },
    ]);
    await tagsPreviewJob(ctx, all);
    const [aAll] = (await itemsOf(all)).filter((i: any) => i.audioFileId === fileA);
    expect(diffMap(aAll).title).toMatchObject({ before: 'Old One', after: 'Canon One', reason: 'policy:overwrite' });

    await tagsPreviewJob(ctx, fill);
    const fillItems = await itemsOf(fill);
    const aFill = fillItems.find((i: any) => i.audioFileId === fileA)!;
    const dFill = diffMap(aFill);
    expect(dFill.title).toBeUndefined();
    expect(dFill.musicbrainz_albumid).toMatchObject({ after: 'rel-mbid-1', reason: 'policy:fill' });
    // file B has an empty title → filled from the canonical track
    const bFill = fillItems.find((i: any) => i.audioFileId === fileB)!;
    expect(diffMap(bFill).title).toMatchObject({ before: null, after: 'Canon Two', reason: 'policy:fill' });
  });
});

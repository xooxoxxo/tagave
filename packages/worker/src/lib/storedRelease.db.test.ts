import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { CanonicalRelease } from '@tagave/core';
import { storedReleases } from './storedRelease.js';
import { upsertCanonical } from './canonical.js';
import { toScorable } from '../jobs/identifyAlbum.js';
import type { WorkerContext } from './context.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('storedReleases (db)', () => {
  let client: any;
  const rg = randomUUID(); const mb = randomUUID(); const dg = randomUUID(); const bare = randomUUID();
  const rgMbid = randomUUID(); const relMbid = randomUUID();

  beforeAll(async () => {
    ({ client } = await makeDb(process.env.TEST_DATABASE_URL!));
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${rgMbid}, 'Lichtung', '["Ensemble Nord"]'::jsonb)`;
    await client`insert into releases (id, release_group_id, mbid, title, status, date, country, barcode, labels, media, track_count, source_of_truth)
                 values (${mb}, ${rg}, ${relMbid}, 'Lichtung', 'Official', '2011-03-01', 'FI', '0123', '[{"name":"Nordlabel","catalogNumber":"NL-1"}]'::jsonb, '[{"position":1,"format":"CD","trackCount":2},{"position":2,"format":"CD","trackCount":1}]'::jsonb, 3, 'musicbrainz'),
                        (${dg}, ${rg}, null, 'Lichtung', null, '2011-01-01', 'DE', null, '[]'::jsonb, '[]'::jsonb, 2, 'discogs'),
                        (${bare}, ${rg}, null, 'Lichtung', null, null, null, null, '[]'::jsonb, '[]'::jsonb, 2, 'discogs')`;
    await client`update releases set discogs_release_id = 424242 where id = ${dg}`;
    await client`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values
                 (${mb}, 2, 1, 'Drei', 180000), (${mb}, 1, 2, 'Zwei', 170000), (${mb}, 1, 1, 'Eins', 160000),
                 (${dg}, 1, 1, 'Eins', null), (${dg}, 1, 2, 'Zwei', null)`;
  });
  afterAll(async () => {
    await client`delete from releases where release_group_id = ${rg}`;
    await client`delete from release_groups where id = ${rg}`;
    await client.end({ timeout: 5 });
  });

  it('rebuilds a MusicBrainz release in medium, position order with its ids', async () => {
    const out = await storedReleases({ sql: client }, [mb]);
    const r = out.get(mb)!;
    expect(r.complete).toBe(true);
    expect(r.release.id).toBe(relMbid);
    expect(r.release.releaseGroupId).toBe(rgMbid);
    expect(r.release.source).toBe('musicbrainz');
    expect(r.release.tracks.map((t) => [t.mediumNumber, t.title, t.duration])).toEqual([[1, 'Eins', 160000], [1, 'Zwei', 170000], [2, 'Drei', 180000]]);
    expect(r.release).toMatchObject({ year: 2011, country: 'FI', barcode: '0123', label: 'Nordlabel', catalogNumber: 'NL-1', artists: ['Ensemble Nord'] });
    expect(r.status).toBe('Official');
  });

  it('a Discogs release is named by its Discogs id and has no durations', async () => {
    const r = (await storedReleases({ sql: client }, [dg])).get(dg)!;
    expect(r.release.id).toBe('424242');
    expect(r.release.tracks.every((t) => t.duration === 0)).toBe(true);
  });

  it('a release with no stored tracks is incomplete', async () => {
    expect((await storedReleases({ sql: client }, [bare])).get(bare)!.complete).toBe(false);
  });
});

// What identify scores is toScorable(provider release); what it stores is
// upsertCanonical(provider release). A rebuilt release must give the scorer
// the same input.
describe.skipIf(!process.env.TEST_DATABASE_URL)('storedReleases round trip (db)', () => {
  let ctx: WorkerContext;
  const groups: string[] = [];
  const mbRelease: CanonicalRelease = {
    id: randomUUID(), releaseGroupId: randomUUID(), title: 'Kaarna', artists: ['Kvartetti Itä'],
    tracks: [
      { title: 'Alku', artists: ['Kvartetti Itä'], duration: 201000, position: 1, mediumNumber: 1, recordingId: randomUUID() },
      { title: 'Keski', artists: ['Kvartetti Itä', 'Vieras'], duration: 187000, position: 2, mediumNumber: 1 },
      { title: 'Loppu', artists: ['Kvartetti Itä'], duration: 240000, position: 1, mediumNumber: 2 },
    ],
    year: 2004, date: '2004-05-12', country: 'FI', barcode: '6417138600123', catalogNumber: 'KI-04',
    media: 'CD', status: 'Official', label: 'Itälevy', source: 'musicbrainz',
  };
  const dgId = 900000000 + Math.floor(Math.random() * 99999999);
  const dgRelease: CanonicalRelease = {
    id: String(dgId), releaseGroupId: `release:${dgId}`, title: 'Kaarna', artists: ['Kvartetti Itä'],
    tracks: [
      { title: 'Alku', artists: ['Kvartetti Itä'], duration: 200000, position: 1, mediumNumber: 1 },
      { title: 'Keski', artists: ['Kvartetti Itä'], duration: 0, position: 2, mediumNumber: 1 },
    ],
    year: 2004, date: '2004-05', country: 'DE', barcode: '6 417138 600123', label: 'Itälevy',
    labels: [{ name: 'Itälevy', catalogNumber: 'KI-04' }], mediaList: [{ position: 1, format: 'Vinyl', trackCount: 1 }],
    source: 'discogs', sourceId: String(dgId),
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
  });
  afterAll(async () => {
    if (groups.length) {
      await ctx.sql`delete from releases where release_group_id = any(${groups}::uuid[])`;
      await ctx.sql`delete from release_groups where id = any(${groups}::uuid[])`;
    }
    await ctx.sql.end({ timeout: 5 });
  });

  it('a stored MusicBrainz release gives the scorer what the fetched one gave', async () => {
    const { releaseId, releaseGroupId } = await upsertCanonical(ctx, mbRelease);
    groups.push(releaseGroupId);
    const r = (await storedReleases(ctx, [releaseId])).get(releaseId)!;
    expect(r.complete).toBe(true);
    expect(r.status).toBe('Official');
    expect(toScorable(r.release)).toEqual(toScorable(mbRelease));
  });

  it('a stored Discogs release scores the same; only its group id is the local one', async () => {
    const { releaseId, releaseGroupId } = await upsertCanonical(ctx, dgRelease);
    groups.push(releaseGroupId);
    const r = (await storedReleases(ctx, [releaseId])).get(releaseId)!;
    expect(r.release.releaseGroupId).toBe(releaseGroupId);
    expect({ ...toScorable(r.release), releaseGroupId: '' }).toEqual({ ...toScorable(dgRelease), releaseGroupId: '' });
  });
});

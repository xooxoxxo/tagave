/**
 * decider.accept against a real database: a model's batch accepted in
 * chunks, every album re-checked before it is accepted (re-identified,
 * moved on, given up on, evidence changed, merged away), the snapshot of
 * what each accept replaced, a retry that accepts nothing twice, and the
 * paced downstream work (one queue notice per chunk, one gaps recompute).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import {
  createBatch, getBatch, libraries, releaseGroups, releases, users, makeDb, type BatchItemInput,
} from '@tagave/db';
import { JOB_EVENTS_CHANNEL } from '@tagave/shared/job';
import type { WorkerContext } from '../lib/context.js';
import { currentEvidenceHash } from '../lib/evidenceStore.js';
import { ACCEPT_CHUNK, deciderAcceptJob, runAcceptBatch } from './deciderAccept.js';

const albumEvidence = (title: string) => ({
  v: 1, artist: 'Batch Artist', title, discsKnown: true, discCount: 1,
  tracks: [{ i: 0, disc: 1, title: 'Ilta', durS: 200 }, { i: 1, disc: 1, title: 'Aamu', durS: 210 }],
});
const candidateEvidence = (title: string) => ({
  v: 1, remote: { provider: 'musicbrainz', title, artists: ['Batch Artist'], year: 2012 },
  tracks: [[1, 'Ilta', 200], [1, 'Aamu', 210]], align: [[0, 0, 0.01], [1, 1, 0.02]],
  unmatchedLocal: [], missingRemote: [], capped: false,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.accept (db)', () => {
  let db: any;
  let client: any;
  let ctx: WorkerContext;
  const send = vi.fn(async (..._args: unknown[]) => 'job');
  const owner = randomUUID();
  const lib = randomUUID();
  const rgId = randomUUID();
  const releaseOf: Record<string, string> = {};
  const madeReleases: string[] = [];
  const unlisteners: Array<() => Promise<void>> = [];
  let albums: string[] = [];

  /** n fresh albums in review, each with one candidate release and stored evidence, identified just now */
  async function freshAlbums(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => randomUUID());
    const rels = ids.map(() => randomUUID());
    const mbids = ids.map(() => randomUUID());
    for (const r of rels) madeReleases.push(r);
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 select r, ${rgId}, m, 'Batch Album', 'Official', 2, 'musicbrainz'
                   from unnest(${rels}::uuid[], ${mbids}::uuid[]) as u(r, m)`;
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, last_identify_at)
                 select a, ${lib}, 'k-' || a::text, array['x/' || a::text], 'Batch Album', 'Batch Artist', 'needs_review', 'close call', 2, now()
                   from unnest(${ids}::uuid[]) as a`;
    const ae = JSON.stringify(albumEvidence('Batch Album'));
    const ce = JSON.stringify(candidateEvidence('Batch Album'));
    await client`insert into album_evidence (local_album_id, v, evidence)
                 select a, 1, ${ae}::text::jsonb from unnest(${ids}::uuid[]) as a`;
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence)
                 select a, r, 0.1, '{}'::jsonb, 'mb_search', ${ce}::text::jsonb
                   from unnest(${ids}::uuid[], ${rels}::uuid[]) as u(a, r)`;
    ids.forEach((id, i) => { releaseOf[id] = rels[i]!; });
    return ids;
  }

  async function modelBatch(ids: string[], over: Partial<BatchItemInput> = {}) {
    const items: BatchItemInput[] = [];
    for (const id of ids) {
      const [a] = await client`select last_identify_at from local_albums where id = ${id}`;
      const at = a.last_identify_at == null ? null : new Date(a.last_identify_at).toISOString();
      items.push({ albumId: id, releaseId: releaseOf[id]!, distance: 0.1, source: 'mb_search', probability: 0.995,
        evidenceHash: await currentEvidenceHash(client, id), expectLastIdentifyAt: at,
        reason: 'model accept: jev-2026-09-15, probability 0.9950', ...over });
    }
    return createBatch(client, { libraryId: lib, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', decidedKind: 'model', startedByUserId: owner, items });
  }

  /** queue.changed payloads on the job events channel, from now on */
  async function queueNotices(): Promise<Array<Record<string, unknown>>> {
    const got: Array<Record<string, unknown>> = [];
    const sub = await client.listen(JOB_EVENTS_CHANNEL, (payload: string) => {
      try {
        const e = JSON.parse(payload);
        if (e.type === 'queue.changed') got.push(e);
      } catch { /* not ours */ }
    });
    unlisteners.push(() => sub.unlisten());
    return got;
  }

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: owner, email: `da-${owner}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: lib, name: 'DeciderAccept', ownerUserId: owner, settings: {} });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Batch Album', artistCredit: ['Batch Artist'] });
  });

  beforeEach(async () => {
    send.mockClear();
    albums = await freshAlbums(9);
  });

  afterAll(async () => {
    for (const u of unlisteners) await u();
    await db.delete(libraries).where(eq(libraries.id, lib)); // cascades albums, matches, batches
    for (let i = 0; i < madeReleases.length; i += 200) await db.delete(releases).where(inArray(releases.id, madeReleases.slice(i, i + 200)));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(users).where(eq(users.id, owner));
    await client.end({ timeout: 5 });
  });

  it('accepts as automatic, by a model, with the batch on every match', async () => {
    const b = await modelBatch(albums.slice(0, 3));
    const r = await runAcceptBatch(ctx, b);
    expect(r.accepted).toBe(3);
    const m = await client`select status, decided_by, decided_kind, decider_id, decider_version, decided_by_user_id, probability::text, batch_id, reason
                             from album_matches where batch_id = ${b}`;
    expect(m).toHaveLength(3);
    expect(m.every((x: any) => x.status === 'auto' && x.decided_by === 'system' && x.decided_kind === 'model' && x.probability === '0.9950')).toBe(true);
    // the person column is the person who decided; the batch says who ran it
    expect(m.every((x: any) => x.decided_by_user_id === null && x.decider_id === 'jev' && x.decider_version === 'jev-2026-09-15')).toBe(true);
    const batch = await getBatch(client, b);
    expect(batch!.state).toBe('accepted');
    expect(batch!.acceptedAt).not.toBeNull();
    const [msg] = await client`select message from decider_batches where id = ${b}`;
    expect(msg.message).toBe('3 accepted, 0 skipped');
    const states = await client`select state from local_albums where id = any(${albums.slice(0, 3)}::uuid[])`;
    expect(states.every((s: any) => s.state === 'matched')).toBe(true);
    const runs = await client`select state, progress from job_runs where type = 'decider.accept' and subject_id = ${b}`;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'completed' });
    expect(runs[0].progress).toMatchObject({ done: 3, total: 3 });
  });

  it('sends no per-album enrichment, cover or track-link work, one queue notice per chunk, one gaps recompute', async () => {
    const more = await freshAlbums(ACCEPT_CHUNK + 1 - albums.length);
    const b = await modelBatch([...albums, ...more]); // two chunks
    const notices = await queueNotices();
    const r = await runAcceptBatch(ctx, b);
    expect(r.accepted).toBe(ACCEPT_CHUNK + 1);
    const queues = send.mock.calls.map((c) => c[0]);
    expect(queues.filter((q) => q === 'enrich.release' || q === 'art.fetch' || q === 'tracks.link')).toEqual([]);
    expect(queues.filter((q) => q === 'gaps.recompute')).toHaveLength(1);
    const gaps = send.mock.calls.find((c) => c[0] === 'gaps.recompute')!;
    expect(gaps[1]).toEqual({ libraryId: lib });
    expect(gaps[2]).toEqual({ singletonKey: `gaps:${lib}` });
    await new Promise((res) => setTimeout(res, 200));
    expect(notices.filter((n) => n['libraryId'] === lib)).toHaveLength(2);
    expect(notices.filter((n) => n['libraryId'] === lib).every((n) => n['localAlbumId'] === null)).toBe(true);
  });

  it('skips an album re-identified after the decision (last identify moved)', async () => {
    const b = await modelBatch([albums[0]!]);
    await client`update local_albums set last_identify_at = now() + interval '1 second' where id = ${albums[0]!}`;
    expect((await runAcceptBatch(ctx, b)).skipped).toEqual({ reidentified: 1 });
    const [it] = await client`select status, skip_reason, match_id from decider_batch_items where batch_id = ${b}`;
    expect(it).toMatchObject({ status: 'skipped', skip_reason: 'reidentified', match_id: null });
  });

  it('skips an album an AcoustID re-identification matched meanwhile', async () => {
    const b = await modelBatch([albums[1]!]);
    await client`update local_albums set state = 'matched' where id = ${albums[1]!}`;
    expect((await runAcceptBatch(ctx, b)).skipped).toEqual({ state: 1 });
  });

  it('skips an album identify gave up on meanwhile', async () => {
    const b = await modelBatch([albums[2]!]);
    await client`update local_albums set state = 'unidentified', identify_reason = 'weak_candidates' where id = ${albums[2]!}`;
    expect((await runAcceptBatch(ctx, b)).skipped).toEqual({ state: 1 });
  });

  it('skips an album whose candidate the owner excluded after the decision', async () => {
    const b = await modelBatch([albums[3]!]);
    await client`update match_candidates set excluded = true where local_album_id = ${albums[3]!}`;
    expect((await runAcceptBatch(ctx, b)).skipped).toEqual({ evidence_changed: 1 });
    const [a] = await client`select state from local_albums where id = ${albums[3]!}`;
    expect(a.state).toBe('needs_review');
  });

  it('skips an album whose chosen release was deleted', async () => {
    const b = await modelBatch([albums[4]!], { evidenceHash: null });
    await client`delete from match_candidates where local_album_id = ${albums[4]!}`;
    await client`delete from releases where id = ${releaseOf[albums[4]!]!}`;
    expect((await runAcceptBatch(ctx, b)).skipped).toEqual({ release_gone: 1 });
  });

  it('carries on past an album merged away mid-batch', async () => {
    const b = await modelBatch([albums[4]!, albums[5]!]);
    await client`delete from local_albums where id = ${albums[4]!}`;
    const r = await runAcceptBatch(ctx, b);
    expect(r).toMatchObject({ accepted: 1, skipped: { gone: 1 } });
    expect((await getBatch(client, b))!.state).toBe('accepted');
  });

  it('a pg-boss retry after a crash accepts nothing twice', async () => {
    const b = await modelBatch([albums[6]!, albums[7]!]);
    await runAcceptBatch(ctx, b);
    const again = await runAcceptBatch(ctx, b);
    expect(again.accepted).toBe(0);
    expect((await client`select 1 from album_matches where batch_id = ${b}`)).toHaveLength(2);
  });

  it('resumes a batch a crash left accepting, at the first pending item', async () => {
    const b = await modelBatch([albums[6]!, albums[7]!]);
    // the crash came after the first item was handled
    await client`update decider_batches set state = 'accepting' where id = ${b}`;
    await client`update decider_batch_items set status = 'skipped', skip_reason = 'state' where batch_id = ${b} and position = 1`;
    const r = await deciderAcceptJob(ctx, { batchId: b });
    expect(r).toMatchObject({ accepted: 1, skipped: {} });
    const [a] = await client`select state from local_albums where id = ${albums[6]!}`;
    expect(a.state).toBe('needs_review');
    expect((await getBatch(client, b))!.state).toBe('accepted');
  });

  it('two runs of one batch at once accept each album once', async () => {
    const b = await modelBatch(albums.slice(0, 6));
    const [x, y] = await Promise.all([runAcceptBatch(ctx, b), runAcceptBatch(ctx, b)]);
    expect(x.accepted + y.accepted).toBe(6);
    expect({ ...x.skipped, ...y.skipped }).toEqual({});
    expect((await client`select 1 from album_matches where batch_id = ${b}`)).toHaveLength(6);
  });

  it('keeps the snapshot of what it replaced', async () => {
    const b = await modelBatch([albums[8]!]);
    await runAcceptBatch(ctx, b);
    const [it] = await client`select prior_state, prior_identify_reason, prior_release_id, prior_match_id, match_id, accepted_at
                                from decider_batch_items where batch_id = ${b}`;
    expect(it).toMatchObject({ prior_state: 'needs_review', prior_identify_reason: 'close call', prior_release_id: null, prior_match_id: null });
    expect(it.match_id).not.toBeNull();
    expect(it.accepted_at).not.toBeNull();
  });

  it('snapshots the live match and identify time an accept replaced', async () => {
    const other = randomUUID();
    madeReleases.push(other);
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 values (${other}, ${rgId}, ${randomUUID()}, 'Batch Album', 'Official', 2, 'musicbrainz')`;
    const [m] = await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason, decided_kind)
                             values (${lib}, ${albums[0]!}, ${other}, 0.2, 'auto', 'system', 'earlier pick', 'system') returning id`;
    await client`update local_albums set release_id = ${other}, release_group_id = ${rgId}, identified_at = '2026-10-01T12:00:00.123Z' where id = ${albums[0]!}`;
    const b = await createBatch(client, {
      libraryId: lib, deciderId: 'jev', deciderVersion: 'jev-2026-09-15', decidedKind: 'model', startedByUserId: owner,
      items: [{ albumId: albums[0]!, releaseId: releaseOf[albums[0]!]!, distance: 0.1, source: 'mb_search', probability: 0.99,
        evidenceHash: null, expectLastIdentifyAt: null, reason: 'model accept: test' }],
    });
    expect((await runAcceptBatch(ctx, b)).accepted).toBe(1);
    const [it] = await client`select prior_release_id, prior_release_group_id, prior_identified_at, prior_match_id, prior_match_status, prior_match_reason
                                from decider_batch_items where batch_id = ${b}`;
    expect(it).toMatchObject({ prior_release_id: other, prior_release_group_id: rgId, prior_match_id: m.id, prior_match_status: 'auto', prior_match_reason: 'earlier pick' });
    expect(new Date(it.prior_identified_at).toISOString()).toBe('2026-10-01T12:00:00.123Z');
  });

  it('fails the batch on an item a model accept refuses, before touching the chunk', async () => {
    const b = await modelBatch(albums.slice(0, 2));
    await client`update decider_batch_items set reason = 'not a model reason' where batch_id = ${b} and position = 2`;
    await expect(runAcceptBatch(ctx, b)).rejects.toBeInstanceOf(RangeError);
    const [row] = await client`select state, message from decider_batches where id = ${b}`;
    expect(row.state).toBe('failed');
    expect(row.message).toMatch(/cannot be accepted/);
    expect((await client`select 1 from album_matches where batch_id = ${b}`)).toHaveLength(0);
    // a retry of the failed batch does nothing
    expect((await runAcceptBatch(ctx, b)).accepted).toBe(0);
  });

  it('does nothing for a batch that is not waiting', async () => {
    const b = await modelBatch([albums[0]!]);
    await client`update decider_batches set state = 'undone' where id = ${b}`;
    expect(await runAcceptBatch(ctx, b)).toEqual({ accepted: 0, undone: 0, skipped: {}, left: {} });
    expect(await runAcceptBatch(ctx, randomUUID())).toEqual({ accepted: 0, undone: 0, skipped: {}, left: {} });
    expect(send).not.toHaveBeenCalled();
  });
});

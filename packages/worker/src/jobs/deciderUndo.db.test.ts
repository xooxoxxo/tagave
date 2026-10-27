/**
 * Undo of an accept batch against a real database: each album's snapshot
 * restored (state, identify reason, release, the earlier live match with its
 * own provenance), track links written since cleared, albums the owner
 * touched since left and listed, the cover asked for again without the
 * wrong release, Music Connections told, and a retry that undoes nothing
 * twice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { createBatch, getBatch, libraries, releaseGroups, requestUndo, users, makeDb, sendDeciderAccept } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { deciderAcceptJob, runAcceptBatch } from './deciderAccept.js';
import { runUndoBatch } from './deciderUndo.js';

// Reading a chunk can be made to do something first (move the batch, fail).
const hooks = vi.hoisted(() => ({ afterFetch: null as null | (() => Promise<void>) }));
vi.mock('@tagave/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tagave/db')>();
  return {
    ...real,
    itemsWithStatus: async (...args: Parameters<typeof real.itemsWithStatus>) => {
      const rows = await real.itemsWithStatus(...args);
      const hook = hooks.afterFetch;
      if (hook) await hook();
      return rows;
    },
  };
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.accept undo (db)', () => {
  let db: any;
  let client: any;
  let ctx: WorkerContext;
  const send = vi.fn(async (..._args: unknown[]) => 'job');
  const owner = randomUUID();
  const lib = randomUUID();
  const rgId = randomUUID();
  const rg2 = randomUUID();
  const rootId = randomUUID();
  const madeReleases: string[] = [];
  const madeSources: string[] = [];
  const releaseOf: Record<string, string> = {};
  const filesOf: Record<string, string[]> = {};
  const priorLiveMatchIdOf: Record<string, string> = {};
  let otherRelease: string;
  let a1: string, a2: string, a3: string, a4: string, a5: string, a6: string, a7: string, a8: string;

  async function release(group: string = rgId): Promise<string> {
    const id = randomUUID();
    madeReleases.push(id);
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 values (${id}, ${group}, ${randomUUID()}, 'Undo Album', 'Official', 2, 'musicbrainz')`;
    return id;
  }

  /** An album in review (ambiguous), two tracks on two files, one candidate release. */
  async function freshAlbum(): Promise<string> {
    const id = randomUUID();
    releaseOf[id] = await release();
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, last_identify_at)
                 values (${id}, ${lib}, ${'k-' + id}, ${['u/' + id]}, 'Undo Album', 'Undo Artist', 'needs_review', 'ambiguous', 2, now())`;
    const fs = [randomUUID(), randomUUID()];
    filesOf[id] = fs;
    for (const [i, f] of fs.entries()) {
      await client`insert into files (id, library_id, scan_root_id, rel_path, status, duration_ms, handler)
                   values (${f}, ${lib}, ${rootId}, ${`u/${id}/0${i + 1}.flac`}, 'present', 1000, 'audio')`;
      await client`insert into local_tracks (local_album_id, audio_file_id, track_no) values (${id}, ${f}, ${i + 1})`;
    }
    return id;
  }

  /** A rule batch over the albums, accepted, and their tracks linked afterwards (as tracks.link would). */
  async function acceptedBatch(ids: string[]): Promise<string> {
    const b = await createBatch(client, {
      libraryId: lib, deciderId: 'rules', deciderVersion: null, decidedKind: 'rule', startedByUserId: owner,
      items: ids.map((id) => ({ albumId: id, releaseId: releaseOf[id]!, distance: 0.05, source: 'mb_search', probability: null,
        evidenceHash: null, expectLastIdentifyAt: null, reason: 'auto-accept rules: distance 0.0500' })),
    });
    expect((await runAcceptBatch(ctx, b)).accepted).toBe(ids.length);
    for (const id of ids) {
      const tracks = await client`select id from local_tracks where local_album_id = ${id} order by track_no`;
      for (const [i, t] of tracks.entries()) {
        const [ct] = await client`insert into canonical_tracks (release_id, position, title) values (${releaseOf[id]!}, ${i + 1}, ${`Song ${i + 1}`}) returning id`;
        await client`update local_tracks set canonical_track_id = ${ct.id}, recording_id = ${randomUUID()}, match_distance = 0.01, state = 'matched' where id = ${t.id}`;
      }
      await client`update local_albums set tracks_linked_at = now() where id = ${id}`;
    }
    send.mockClear();
    return b;
  }

  /** A live match on another release before the accept, as the matcher's own pick. */
  async function priorLiveMatch(albumId: string, over: { probability?: string } = {}): Promise<string> {
    const other = await release();
    const [m] = await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, reason, decided_kind, decider_id, probability)
                             values (${lib}, ${albumId}, ${other}, 0.2, 'auto', 'system', 'earlier pick', 'system', 'matcher', ${over.probability ?? null})
                             returning id`;
    await client`update local_albums set release_id = ${other}, release_group_id = ${rgId} where id = ${albumId}`;
    priorLiveMatchIdOf[albumId] = m.id;
    return m.id;
  }

  async function providerCover(albumId: string): Promise<void> {
    const [s] = await client`insert into image_sources (entity_type, entity_id, kind, provider, source_url, license_note)
                             values ('release', ${releaseOf[albumId]!}, 'front', 'caa', 'https://example.test/front.jpg', 'test') returning id`;
    madeSources.push(s.id);
    await client`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, image_source_id, license_note)
                 values (${lib}, 'local_album', ${albumId}, ${albumId}, 'front', 'provider', ${s.id}, 'test')`;
  }

  /** A tag plan created now with an item for one of the album's files. */
  async function planTouching(albumId: string): Promise<void> {
    const [plan] = await client`insert into tag_plans (library_id, name, scope, policy, status, created_by)
                                values (${lib}, 'p', '{}', '{}', 'draft', ${owner}) returning id`;
    await client`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status)
                 values (${plan.id}, ${filesOf[albumId]![0]!}, '{}', '{}', '[]', 'pending')`;
  }

  const identityLogs = async () =>
    (await client`select count(*)::int as n from facet_changes where facet = 'album.identity@1' and library_id = ${lib} and key = ${rgId}`)[0].n as number;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: owner, email: `du-${owner}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: lib, name: 'DeciderUndo', ownerUserId: owner, settings: {} });
    await db.insert(releaseGroups).values({ id: rgId, mbid: randomUUID(), title: 'Undo Album', artistCredit: ['Undo Artist'] });
    await db.insert(releaseGroups).values({ id: rg2, mbid: randomUUID(), title: 'Undo Album (other)', artistCredit: ['Undo Artist'] });
    await client`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${lib}, '/nonexistent-du', 'du', 'ok')`;
  });

  beforeEach(async () => {
    send.mockClear();
    hooks.afterFetch = null;
    [a1, a2, a3, a4, a5, a6, a7, a8] = await Promise.all(Array.from({ length: 8 }, () => freshAlbum())) as string[] as [string, string, string, string, string, string, string, string];
    await priorLiveMatch(a1);
    await providerCover(a2);
    otherRelease = await release();
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, lib)); // cascades albums, files, matches, batches, images
    if (madeSources.length) await client`delete from image_sources where id = any(${madeSources}::uuid[])`;
    await client`delete from releases where id = any(${madeReleases}::uuid[])`;
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rgId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, rg2));
    await db.delete(users).where(eq(users.id, owner));
    await client.end({ timeout: 5 });
  });

  it('restores state, release and the replaced match, and clears links written since', async () => {
    const b = await acceptedBatch([a1]);
    const r = await runUndoBatch(ctx, b);
    expect(r.undone).toBe(1);
    const [al] = await client`select state, release_id, release_group_id, identify_reason, tracks_linked_at from local_albums where id = ${a1}`;
    // the prior live match pointed the album at its release; that comes back
    expect(al).toMatchObject({ state: 'needs_review', identify_reason: 'ambiguous', tracks_linked_at: null });
    const [prior] = await client`select release_id from album_matches where id = ${priorLiveMatchIdOf[a1]!}`;
    expect(al.release_id).toBe(prior.release_id);
    const tracks = await client`select canonical_track_id, recording_id, match_distance, state from local_tracks where local_album_id = ${a1}`;
    expect(tracks.every((t: any) => t.canonical_track_id === null && t.recording_id === null && t.match_distance === null && t.state === 'unmatched')).toBe(true);
    const live = await client`select id from album_matches where local_album_id = ${a1} and status in ('auto', 'confirmed')`;
    expect(live.map((x: any) => x.id)).toEqual(priorLiveMatchIdOf[a1] ? [priorLiveMatchIdOf[a1]] : []);
    const batch = await getBatch(client, b);
    expect(batch!.state).toBe('undone');
    expect(batch!.undoneAt).not.toBeNull();
    expect(batch!.undoRequestedAt).not.toBeNull();
    expect(batch!.message).toBe('1 undone, 0 left');
    const [item] = await client`select status, skip_reason, undone_at from decider_batch_items where batch_id = ${b}`;
    expect(item).toMatchObject({ status: 'undone', skip_reason: null });
    expect(item.undone_at).not.toBeNull();
  });

  it('an album with no match before the accept goes back to review with no release and no live match', async () => {
    const b = await acceptedBatch([a7]);
    await runUndoBatch(ctx, b);
    const [al] = await client`select state, release_id, release_group_id, identify_reason from local_albums where id = ${a7}`;
    expect(al).toMatchObject({ state: 'needs_review', release_id: null, release_group_id: null, identify_reason: 'ambiguous' });
    expect(await client`select 1 from album_matches where local_album_id = ${a7} and status in ('auto', 'confirmed')`).toHaveLength(0);
    const [m] = await client`select status, reason from album_matches where batch_id = ${b}`;
    expect(m).toMatchObject({ status: 'rejected', reason: 'auto-accept rules: distance 0.0500' });
  });

  it('the restored match keeps its own provenance', async () => {
    const m = await priorLiveMatch(a6, { probability: '0.8100' });
    const b = await acceptedBatch([a6]);
    await runUndoBatch(ctx, b);
    const [row] = await client`select status, decided_by, decided_kind, decider_id, probability::text, batch_id, reason from album_matches where id = ${m}`;
    expect(row).toMatchObject({ status: 'auto', decided_by: 'system', decided_kind: 'system', decider_id: 'matcher', probability: '0.8100', batch_id: null, reason: 'earlier pick' });
  });

  it('asks for the cover again without the wrong release, and recomputes gaps once', async () => {
    const b = await acceptedBatch([a2, a3]); // a2 has a provider front image, a3 none
    await runUndoBatch(ctx, b);
    expect(send).toHaveBeenCalledWith('art.fetch', { localAlbumId: a2, refresh: true, reselect: true }, { singletonKey: `artRefresh:${a2}` });
    expect(send.mock.calls.filter((c) => c[0] === 'art.fetch')).toHaveLength(1);
    expect(send.mock.calls.filter((c) => c[0] === 'gaps.recompute')).toHaveLength(1);
    expect(send).toHaveBeenCalledWith('gaps.recompute', { libraryId: lib }, { singletonKey: `gaps:${lib}` });
  });

  it('Music Connections logs the album\'s identity on an undo', async () => {
    const b = await acceptedBatch([a7]);
    const before = await identityLogs();
    await runUndoBatch(ctx, b);
    expect(await identityLogs()).toBeGreaterThan(before);
  });

  it('leaves and lists albums the owner touched since', async () => {
    const b = await acceptedBatch([a3, a4, a5, a6]);
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind, reason)
                 select library_id, local_album_id, release_id, distance, 'rejected', 'user', 'user', 'x' from album_matches where local_album_id = ${a3} limit 1`;
    await client`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${lib}, 'album', ${a4}, 'title', ${owner})`;
    await planTouching(a5); // a tag plan created now with an item for one of a5's files
    await client`update local_albums set state = 'as_is' where id = ${a6}`;
    const r = await runUndoBatch(ctx, b);
    expect(r.left).toEqual({ newer_decision: 1, locks: 1, tag_plan: 1, state_changed: 1 });
    const [al] = await client`select state from local_albums where id = ${a4}`;
    expect(al.state).toBe('matched');
    const items = await client`select local_album_id, status, skip_reason from decider_batch_items where batch_id = ${b} order by position`;
    expect(items.map((i: any) => [i.local_album_id, i.status, i.skip_reason])).toEqual([
      [a3, 'left', 'newer_decision'], [a4, 'left', 'locks'], [a5, 'left', 'tag_plan'], [a6, 'left', 'state_changed'],
    ]);
    expect((await getBatch(client, b))!).toMatchObject({ state: 'undone', message: '0 undone, 4 left' });
    // nothing was undone: no cover, queue or gaps work
    expect(send).not.toHaveBeenCalled();
  });

  it('a lock on one of the album\'s tracks (by its file) leaves the album; a lock from before the accept does not', async () => {
    await client`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${lib}, 'album', ${a4}, 'title', ${owner})`;
    const b = await acceptedBatch([a3, a4]);
    await client`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${lib}, 'track', ${filesOf[a3]![1]!}, 'title', ${owner})`;
    const r = await runUndoBatch(ctx, b);
    expect(r).toMatchObject({ undone: 1, left: { locks: 1 } });
    const [al] = await client`select state from local_albums where id = ${a4}`;
    expect(al.state).toBe('needs_review');
  });

  it('a lock on one of the album\'s tracks (by the local track) leaves the album', async () => {
    const b = await acceptedBatch([a3]);
    const [t] = await client`select id from local_tracks where local_album_id = ${a3} limit 1`;
    await client`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${lib}, 'track', ${t.id}, 'title', ${owner})`;
    expect((await runUndoBatch(ctx, b)).left).toEqual({ locks: 1 });
  });

  it('a change of the album\'s release group alone leaves the album', async () => {
    const b = await acceptedBatch([a3]);
    await client`update local_albums set release_group_id = ${rg2} where id = ${a3}`;
    expect((await runUndoBatch(ctx, b)).left).toEqual({ state_changed: 1 });
    const [al] = await client`select state, release_group_id from local_albums where id = ${a3}`;
    expect(al).toMatchObject({ state: 'matched', release_group_id: rg2 });
  });

  it('the replaced match moved to another release by a relink: the album follows the restored match', async () => {
    const b = await acceptedBatch([a1]);
    const [prior] = await client`select release_id from album_matches where id = ${priorLiveMatchIdOf[a1]!}`;
    // as a relink does: the matches move to the new release, the old one is deleted
    const moved = await release(rg2);
    await client`update local_albums set release_id = ${moved}, release_group_id = ${rg2} where release_id = ${prior.release_id}`;
    await client`update album_matches set release_id = ${moved} where release_id = ${prior.release_id}`;
    await client`delete from releases where id = ${prior.release_id}`;
    expect((await runUndoBatch(ctx, b)).undone).toBe(1);
    const [al] = await client`select state, release_id, release_group_id from local_albums where id = ${a1}`;
    expect(al).toMatchObject({ state: 'needs_review', release_id: moved, release_group_id: rg2 });
    const live = await client`select id, release_id from album_matches where local_album_id = ${a1} and status in ('auto', 'confirmed')`;
    expect(live.map((x: any) => [x.id, x.release_id])).toEqual([[priorLiveMatchIdOf[a1], moved]]);
  });

  it('the owner endorsing the batch\'s own match (any edition) leaves the album', async () => {
    const b = await acceptedBatch([a3]);
    await client`update album_matches set decided_by = 'user', decided_kind = 'user', decided_by_user_id = ${owner}, release_group_only = true where batch_id = ${b}`;
    expect((await runUndoBatch(ctx, b)).left).toEqual({ newer_decision: 1 });
  });

  it('a second undo changes nothing', async () => {
    const b = await acceptedBatch([a7]);
    await runUndoBatch(ctx, b);
    expect(await runUndoBatch(ctx, b)).toEqual({ accepted: 0, undone: 0, skipped: {}, left: {} });
  });

  it('a later re-identification that superseded the match leaves the album', async () => {
    const b = await acceptedBatch([a8]);
    // identify ran again and went live with another release
    await client`update album_matches set status = 'rejected' where batch_id = ${b}`;
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind, reason)
                 values (${lib}, ${a8}, ${otherRelease}, 0.01, 'auto', 'system', 'system', 'auto-accept: distance 0.0100 (musicbrainz)')`;
    await client`update local_albums set release_id = ${otherRelease} where id = ${a8}`;
    expect((await runUndoBatch(ctx, b)).left).toEqual({ state_changed: 1 });
  });

  it('the replaced match gone with its release: the album is put back anyway', async () => {
    const b = await acceptedBatch([a1]);
    const [prior] = await client`select release_id from album_matches where id = ${priorLiveMatchIdOf[a1]!}`;
    await client`delete from releases where id = ${prior.release_id}`; // cascades the prior match
    expect((await runUndoBatch(ctx, b)).undone).toBe(1);
    const [al] = await client`select state, release_id, release_group_id from local_albums where id = ${a1}`;
    expect(al).toMatchObject({ state: 'needs_review', release_id: null, release_group_id: null });
    expect(await client`select 1 from album_matches where local_album_id = ${a1} and status in ('auto', 'confirmed')`).toHaveLength(0);
  });

  it('the batch\'s own match gone (its release deleted): nobody decided since, so the album is undone', async () => {
    const b = await acceptedBatch([a7]);
    await client`delete from releases where id = ${releaseOf[a7]!}`; // cascades the batch's match; the album still points at it
    expect((await runUndoBatch(ctx, b)).undone).toBe(1);
    const [al] = await client`select state, release_id from local_albums where id = ${a7}`;
    expect(al).toMatchObject({ state: 'needs_review', release_id: null });
  });

  it('undoes a failed batch: its earlier chunks stay accepted', async () => {
    const b = await acceptedBatch([a3, a4]);
    await client`update decider_batches set state = 'failed', message = 'Accept stopped: x' where id = ${b}`;
    expect((await runUndoBatch(ctx, b)).undone).toBe(2);
    expect((await getBatch(client, b))!.state).toBe('undone');
  });

  it('does nothing for a batch that is not accepted, failed or undoing', async () => {
    const b = await acceptedBatch([a3]);
    for (const state of ['queued', 'accepting', 'undone']) {
      await client`update decider_batches set state = ${state} where id = ${b}`;
      expect(await runUndoBatch(ctx, b)).toEqual({ accepted: 0, undone: 0, skipped: {}, left: {} });
    }
    expect(await runUndoBatch(ctx, randomUUID())).toEqual({ accepted: 0, undone: 0, skipped: {}, left: {} });
    const [al] = await client`select state from local_albums where id = ${a3}`;
    expect(al.state).toBe('matched');
  });

  it('runs through decider.accept in undo mode after a request, and keeps who asked', async () => {
    const b = await acceptedBatch([a3]);
    expect(await requestUndo(client, b, owner)).toBe(true);
    expect(await requestUndo(client, b, owner)).toBe(false); // already undoing
    const sent = vi.fn(async (..._a: unknown[]) => 'job');
    await sendDeciderAccept({ send: sent }, b, 'undo');
    const [name, data] = sent.mock.calls[0]!;
    expect(name).toBe('decider.accept');
    const r = await deciderAcceptJob(ctx, data as { batchId: string; mode: 'undo' });
    expect(r.undone).toBe(1);
    expect((await getBatch(client, b))!).toMatchObject({ state: 'undone', undoByUserId: owner });
    const runs = await client`select state, progress from job_runs where type = 'decider.accept' and subject_id = ${b} order by created_at`;
    expect(runs.at(-1)).toMatchObject({ state: 'completed' });
    expect(runs.at(-1).progress).toMatchObject({ done: 1, total: 1, message: '1 undone, 0 left' });
  });

  it('two undo runs of one batch at once undo each album once', async () => {
    const b = await acceptedBatch([a3, a4, a5, a6]);
    const [x, y] = await Promise.all([runUndoBatch(ctx, b), runUndoBatch(ctx, b)]);
    expect(x.undone + y.undone).toBe(4);
    expect({ ...x.left, ...y.left }).toEqual({});
    expect(await client`select 1 from album_matches where local_album_id = any(${[a3, a4, a5, a6]}::uuid[]) and status in ('auto', 'confirmed')`).toHaveLength(0);
  });

  it('a failure with a retry to come leaves the batch undoing, and the retry carries on', async () => {
    const b = await acceptedBatch([a3, a4]);
    hooks.afterFetch = async () => { hooks.afterFetch = null; throw new Error('connection lost'); };
    await expect(runUndoBatch(ctx, b, { lastAttempt: false })).rejects.toThrow('connection lost');
    expect((await getBatch(client, b))!.state).toBe('undoing');
    const [failed] = await client`select state, error from job_runs where type = 'decider.accept' and subject_id = ${b} and state = 'failed'`;
    expect(failed).toMatchObject({ state: 'failed', error: 'connection lost' });
    const r = await deciderAcceptJob(ctx, { batchId: b, mode: 'undo' }, { lastAttempt: false });
    expect(r.undone).toBe(2);
    expect((await getBatch(client, b))!.state).toBe('undone');
  });

  it('a failure on the last attempt fails the batch with a label for the error, and a later undo resumes it', async () => {
    const b = await acceptedBatch([a3, a4]);
    hooks.afterFetch = async () => { throw 'deadlock detected'; };
    await expect(deciderAcceptJob(ctx, { batchId: b, mode: 'undo' }, { lastAttempt: true })).rejects.toBe('deadlock detected');
    expect((await getBatch(client, b))!).toMatchObject({ state: 'failed', message: 'Undo stopped: unexpected error' });
    expect(send).not.toHaveBeenCalled();
    hooks.afterFetch = null;
    expect((await runUndoBatch(ctx, b)).undone).toBe(2);
  });

  it('stops after the chunk in hand when the batch is moved on mid-run', async () => {
    const b = await acceptedBatch([a3]);
    hooks.afterFetch = async () => { hooks.afterFetch = null; await client`update decider_batches set state = 'failed' where id = ${b}`; };
    const r = await runUndoBatch(ctx, b);
    expect(r.undone).toBe(1);
    expect((await getBatch(client, b))!.state).toBe('failed');
    expect(send.mock.calls.filter((c) => c[0] === 'gaps.recompute')).toHaveLength(0);
  });
});

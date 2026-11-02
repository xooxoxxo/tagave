/**
 * decider.run against a real database, with a fake decider (nothing leaves
 * the machine): each album in the population decided and recorded, the run
 * pinned to the dated model of its first answer, excluded and linked-app
 * candidates never sent, stored answers reused so a retry or a re-run never
 * bills twice, albums too large or not sendable skipped and listed, and the
 * pauses (module off, no key, cap or price, cap reached, key refused, model
 * changed).
 *
 * On a scratch database: the run needs the module switched on, and the
 * shared test database's switch belongs to every suite running at once.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import pino from 'pino';
import {
  DEFAULT_TOKENS_PER_BYTE, makeDb, markPayloadSeen, monthSpend, pauseStaleRuns, runMigrations, runSpendByCurrency, setAutotaggerConfig as setConfig, setAutotaggerEnabled, setTypesafeKey, syncInstalledModules,
} from '@tagave/db';
import { buildAlbumEvidence, buildCandidateEvidence, jevPayloadFor, jevSpecHash, requestForAlbum, requestOptions, sealSecret, type Decider, type DeciderInput } from '@tagave/core';
import { ledgerEntries } from '@tagave/core/facets';
import { autotaggerConfigPatchSchema, type Population } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { currentEvidenceHash, loadEvidence, upsertAlbumEvidence } from '../lib/evidenceStore.js';
import { JevKeyRefused, JevRejected, JevUnavailable } from '../lib/jevClient.js';
import { populationAlbumIds } from '../lib/deciderPopulation.js';
import { DECIDER_RUN_LOCK_NAMESPACE, RUN_MAX_RETRIES, deciderRunJob } from './deciderRun.js';

const SECRET = 'test-app-secret-0123456789abcdef01234567';
const parse = (raw: unknown) => autotaggerConfigPatchSchema.parse(raw);

function fakeDecider(
  answer: (input: DeciderInput) => Record<string, number> | Error | Promise<Record<string, number> | Error>,
  model: (n: number) => string = () => 'jev-2026-09-15',
): Decider & { calls: DeciderInput[] } {
  const calls: DeciderInput[] = [];
  return {
    id: 'jev', specHash: jevSpecHash(), calls, build: jevPayloadFor,
    async ask(input) {
      calls.push(input);
      const a = await answer(input);
      if (a instanceof Error) throw a;
      return { probabilities: a, model: model(calls.length), inputTokens: 1000, requestBytes: 4000, raw: {} };
    },
  };
}

interface Cand { distance: number; titles?: string[]; status?: string | null; source?: string; excluded?: boolean; noEvidence?: boolean; sameReleaseAs?: number }

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.run (scratch db)', () => {
  let admin: postgres.Sql;
  let client: any;
  let ctx: WorkerContext;
  const name = `tagave_drtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const owner = randomUUID();
  const lib = randomUUID();
  const lib2 = randomUUID();
  const rg = randomUUID();
  let albumA = '', officialReleaseOfA = '', excludedRelease = '', mcRelease = '';
  let bootlegOnlyAlbum = '', hugeAlbum = '', folderTitled = '', partialAlbum = '', mismatchedTitle = '', weakAlbum = '';
  let brokenAlbum = '', twiceAlbum = '', twiceRelease = '', cappedAlbum = '', shapelessAlbum = '';
  const send = vi.fn(async (..._args: unknown[]): Promise<string | null> => 'job');

  const setAutotaggerConfig = (_c: unknown, libraryId: string, patch: unknown) => setConfig(client, libraryId, patch, parse);

  /** An album with stored evidence and its candidates; a candidate's tracklist defaults to the album's. */
  async function makeAlbum(libraryId: string, o: {
    title: string; tracks: string[]; candidates: Cand[]; state?: string; identifyReason?: string | null;
    titleSource?: 'tag' | 'folder'; evidenceTitleSource?: 'tag' | 'folder';
  }): Promise<{ id: string; releases: string[] }> {
    const id = randomUUID();
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, title_source, last_identify_at)
                 values (${id}, ${libraryId}, ${'k-' + id}, ${['x/' + id]}, ${o.title}, 'Kuunvalo', ${o.state ?? 'needs_review'}, ${o.identifyReason ?? 'close call'},
                         ${o.tracks.length}, ${o.titleSource ?? 'tag'}, now())`;
    const album = buildAlbumEvidence({
      artist: 'Kuunvalo', title: o.title, titleSource: o.evidenceTitleSource ?? o.titleSource ?? 'tag', year: 2001, yearSource: 'tag',
      discsKnown: false, discCount: null,
      tracks: o.tracks.map((t, i) => ({ title: t, titleSource: 'tag' as const, duration: 200 + i * 10 })),
    });
    await upsertAlbumEvidence(client, id, album);
    const releases: string[] = [];
    for (const c of o.candidates) {
      const again = c.sameReleaseAs === undefined ? null : releases[c.sameReleaseAs]!;
      const rid = again ?? randomUUID();
      const titles = c.titles ?? o.tracks;
      releases.push(rid);
      if (!again) await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                   values (${rid}, ${rg}, ${randomUUID()}, ${o.title}, ${c.status === undefined ? 'Official' : c.status}, ${titles.length}, 'musicbrainz')`;
      const shared = Math.min(o.tracks.length, titles.length);
      const ev = buildCandidateEvidence(
        { source: 'musicbrainz', title: o.title, artists: ['Kuunvalo'], status: c.status === undefined ? 'Official' : c.status,
          tracks: titles.map((t, i) => ({ title: t, duration: 200 + i * 10 })) },
        {
          alignment: o.tracks.map((_, i) => ({ localIndex: i, canonicalIndex: i < shared ? i : null, distance: 0.01, title: { local: '' }, duration: { local: 0 } })),
          missingRemote: titles.map((_, i) => i).filter((i) => i >= shared),
        },
        o.tracks.length);
      await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence, excluded)
                   values (${id}, ${rid}, ${c.distance}, '{}'::jsonb, ${c.source ?? 'mb_search'},
                           ${c.noEvidence ? null : JSON.stringify(ev)}::text::jsonb, ${c.excluded ?? false})`;
    }
    return { id, releases };
  }

  async function newRunIn(libraryId: string, population: Population = 'needs_review') {
    const [r] = await client`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, started_by_user_id)
                             values (${libraryId}, 'jev', ${jevSpecHash()}, 'jev-latest', ${population}, ${owner}) returning id`;
    return r.id as string;
  }
  const newRun = (population: Population = 'needs_review') => newRunIn(lib, population);
  const decisionOf = async (albumId: string) =>
    (await client`select outcome, band, reason, group_label, release_id, probability::text, margin::text, evidence_hash, last_identify_at, call_id
                    from decider_decisions where local_album_id = ${albumId} order by created_at desc limit 1`)[0];

  beforeAll(async () => {
    admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    await runMigrations(u.toString(), { log: () => undefined });
    const made = await makeDb(u.toString());
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(client, ledgerEntries());
    // the columns of pg-boss's job table the stale-run sweep reads (this database has no pg-boss)
    await client`create schema if not exists pgboss`;
    await client`create table if not exists pgboss.job (name text not null, singleton_key text, state text not null)`;
    await client`insert into users (id, email, password_hash) values (${owner}, ${`dr-${owner}@test.com`}, 'x')`;
    for (const id of [lib, lib2]) await client`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${owner}, 'DeciderRun', '{}'::jsonb)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Kuunvalo', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;

    const three = ['Ilta', 'Aamu', 'Yö'];
    // two editions of one tracklist (the Promotion one is the closer), another
    // tracklist, an excluded candidate and a linked app's suggestion
    const a = await makeAlbum(lib, {
      title: 'Kuunvalo', tracks: three, candidates: [
        { distance: 0.05, status: 'Official' }, { distance: 0.04, status: 'Promotion' },
        { distance: 0.2, titles: [...three, 'Bonus'] },
        { distance: 0.03, excluded: true }, { distance: 0.02, source: 'mc:link' },
      ],
    });
    albumA = a.id; officialReleaseOfA = a.releases[0]!; excludedRelease = a.releases[3]!; mcRelease = a.releases[4]!;
    bootlegOnlyAlbum = (await makeAlbum(lib, { title: 'Bootleg', tracks: three, candidates: [{ distance: 0.05, status: 'Bootleg' }, { distance: 0.06, status: 'Bootleg' }] })).id;
    const forty = Array.from({ length: 40 }, (_, i) => `Satz ${i + 1}`);
    hugeAlbum = (await makeAlbum(lib, { title: 'Grosses Werk', tracks: forty, candidates: [{ distance: 0.05 }] })).id;
    await makeAlbum(lib, { title: 'Lichtung', tracks: three, candidates: [{ distance: 0.05 }] });
    // never sent: an album titled from its folder, and one whose evidence says so
    folderTitled = (await makeAlbum(lib, { title: 'Kansio', titleSource: 'folder', tracks: three, candidates: [{ distance: 0.05 }] })).id;
    mismatchedTitle = (await makeAlbum(lib, { title: 'Ristiriita', evidenceTitleSource: 'folder', tracks: three, candidates: [{ distance: 0.05 }] })).id;
    // one sendable candidate has no evidence yet: the set would be partial
    partialAlbum = (await makeAlbum(lib, { title: 'Puolikas', tracks: three, candidates: [{ distance: 0.05 }, { distance: 0.1, noEvidence: true }] })).id;
    // unidentified with weak candidates: seven tracklists, five sent
    weakAlbum = (await makeAlbum(lib, {
      title: 'Schwach', state: 'unidentified', identifyReason: 'weak_candidates', tracks: three,
      candidates: Array.from({ length: 7 }, (_, k) => ({ distance: 0.3 + k * 0.05, titles: Array.from({ length: k + 1 }, (_, j) => `Teil ${j + 1}`) })),
    })).id;
    // one release offered twice (two searches found it); a candidate whose
    // stored pairing points past the album's tracks
    const twice = await makeAlbum(lib, { title: 'Kaksoset', tracks: three, candidates: [{ distance: 0.05, source: 'discogs_search' }, { distance: 0.08, sameReleaseAs: 0 }] });
    twiceAlbum = twice.id; twiceRelease = twice.releases[0]!;
    brokenAlbum = (await makeAlbum(lib, { title: 'Rikki', tracks: three, candidates: [{ distance: 0.05 }] })).id;
    await client`update match_candidates set evidence = jsonb_set(evidence, '{align}', '[[9, 0, 0.01]]'::jsonb) where local_album_id = ${brokenAlbum}`;
    // evidence of the wrong shape (no remote, no tracks), and a tracklist over the alignment cap
    shapelessAlbum = (await makeAlbum(lib, { title: 'Muoto', tracks: three, candidates: [{ distance: 0.05 }] })).id;
    await client`update match_candidates set evidence = '{"v": 1}'::jsonb where local_album_id = ${shapelessAlbum}`;
    cappedAlbum = (await makeAlbum(lib, { title: 'Ylisuuri', tracks: three, candidates: [{ distance: 0.05 }] })).id;
    await client`update match_candidates set evidence = jsonb_set(evidence, '{capped}', 'true'::jsonb) where local_album_id = ${cappedAlbum}`;
    await makeAlbum(lib2, { title: 'Toinen', tracks: three, candidates: [{ distance: 0.05 }] });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    send.mockReset();
    send.mockImplementation(async () => 'job');
    await client`delete from pgboss.job`;
    await client`delete from job_runs where library_id in (${lib}, ${lib2})`;
    await client`delete from decider_runs where library_id in (${lib}, ${lib2})`; // decisions go with them
    await client`delete from decider_calls where library_id in (${lib}, ${lib2})`;
    await client`delete from decider_library_settings where library_id in (${lib}, ${lib2})`;
    await setAutotaggerEnabled(client, true);
    // the whole config, so no limit set by one test leaks into the next
    await setAutotaggerConfig(client, lib, { monthlyCap: 10, maxRequestBytes: null, currency: 'USD' });
    // the owner has seen the payload in both libraries
    for (const id of [lib, lib2]) await markPayloadSeen(client, id, owner);
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev', '*', 1, 'USD')
                 on conflict (decider_id, model) do update set per_million_input = 1, currency = 'USD'`;
    await client`delete from decider_prices where model <> '*'`;
  });

  it('decides each album in review: a pick has its group, the edition by the rules, band and probability', async () => {
    const d = fakeDecider(() => ({ A: 0.995, B: 0.1 }));
    const run = await newRun();
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s.state).toBe('done');
    const [dec] = await client`select outcome, group_label, release_id, band, probability::text, margin::text, evidence_hash, last_identify_at, request_bytes
                                 from decider_decisions where run_id = ${run} and local_album_id = ${albumA}`;
    expect(dec).toMatchObject({ outcome: 'pick', group_label: 'A', band: 'p99', probability: '0.9950', margin: '0.8950' });
    // the closer edition is a promotion: the owner's rules (official only) pick the other
    expect(dec.release_id).toBe(officialReleaseOfA);
    expect(dec.evidence_hash).toBe(await currentEvidenceHash(client, albumA));
    const [la] = await client`select last_identify_at from local_albums where id = ${albumA}`;
    expect(new Date(dec.last_identify_at).toISOString()).toBe(new Date(la.last_identify_at).toISOString());
    expect(dec.request_bytes).toBeGreaterThan(0);
    // an answer that skips a group asked about is no answer
    expect(await decisionOf(bootlegOnlyAlbum)).toMatchObject({ outcome: 'none', reason: 'invalid_answer' });
    const [r] = await client`select state, finished_at from decider_runs where id = ${run}`;
    expect(r.state).toBe('done');
    expect(r.finished_at).not.toBeNull();
  });

  it('pins the run to the dated model the first answer names', async () => {
    const run = await newRun();
    await deciderRunJob(ctx, { runId: run }, { decider: fakeDecider(() => ({ A: 0.99 })), apiKey: 'k' });
    expect((await client`select decider_version from decider_runs where id = ${run}`)[0].decider_version).toBe('jev-2026-09-15');
  });

  it('never sends excluded or linked-app candidates, nor an album titled from its folder', async () => {
    const d = fakeDecider(() => ({ A: 0.99 }));
    const run = await newRun();
    await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    const sent = d.calls.flatMap((i) => i.groups.flatMap((g) => g.members.map((m) => m.releaseId)));
    expect(sent).not.toContain(excludedRelease);
    expect(sent).not.toContain(mcRelease);
    expect(d.calls.map((c) => c.album.title)).not.toContain('Kansio');
    expect(await populationAlbumIds(client, lib, 'needs_review')).not.toContain(folderTitled);
    // its evidence says the title came from the folder: left out and listed, not asked
    expect(d.calls.map((c) => c.album.title)).not.toContain('Ristiriita');
    expect(await decisionOf(mismatchedTitle)).toMatchObject({ outcome: 'no_candidates', reason: 'album_title', call_id: null });
  });

  it('refuses an album whose candidates are only partly evidenced, without asking', async () => {
    const d = fakeDecider(() => ({ A: 0.99 }));
    const s = await deciderRunJob(ctx, { runId: await newRun() }, { decider: d, apiKey: 'k' });
    expect(d.calls.map((c) => c.album.title)).not.toContain('Puolikas');
    expect(await decisionOf(partialAlbum)).toMatchObject({ outcome: 'no_candidates', reason: 'partial_evidence' });
    expect(s.decided['no_candidates']).toBe(2);
  });

  it('sends a release offered twice once, at its best distance; lists unusable evidence and carries on', async () => {
    const d = fakeDecider(() => ({ A: 0.99 }));
    const run = await newRun();
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s.state).toBe('done');
    const twice = d.calls.find((c) => c.album.title === 'Kaksoset')!;
    expect(twice.groups.flatMap((g) => g.members.map((m) => [m.releaseId, m.distance]))).toEqual([[twiceRelease, 0.05]]);
    const [dec] = await client`select outcome, release_id, source, distance::text from decider_decisions where run_id = ${run} and local_album_id = ${twiceAlbum}`;
    expect(dec).toMatchObject({ outcome: 'pick', release_id: twiceRelease, source: 'discogs_search', distance: '0.0500' });
    expect(d.calls.map((c) => c.album.title)).not.toContain('Rikki');
    expect(await decisionOf(brokenAlbum)).toMatchObject({ outcome: 'error', reason: 'invalid_evidence' });
    // a type error from evidence of the wrong shape is the album's, not the run's
    expect(d.calls.map((c) => c.album.title)).not.toContain('Muoto');
    expect(await decisionOf(shapelessAlbum)).toMatchObject({ outcome: 'error', reason: 'invalid_evidence', evidence_hash: null });
    // over the alignment cap: no pairing to send
    expect(d.calls.map((c) => c.album.title)).not.toContain('Ylisuuri');
    expect(await decisionOf(cappedAlbum)).toMatchObject({ outcome: 'too_large', reason: 'capped' });
  });

  it('a retry or a second run over the same evidence never bills twice', async () => {
    const d = fakeDecider(() => ({ A: 0.99 }));
    await deciderRunJob(ctx, { runId: await newRun() }, { decider: d, apiKey: 'k' });
    const first = d.calls.length;
    expect(first).toBeGreaterThan(2);
    // a new run starts with no model pinned: the last finished run's model is reused
    const r2 = await newRun();
    const s2 = await deciderRunJob(ctx, { runId: r2 }, { decider: d, apiKey: 'k' });
    expect(d.calls.length).toBe(first);
    expect(s2).toMatchObject({ state: 'done', reused: first, billed: 0 });
    expect((await client`select count(*)::int as n from decider_calls where library_id = ${lib}`)[0].n).toBe(first);
    expect((await client`select decider_version from decider_runs where id = ${r2}`)[0].decider_version).toBe('jev-2026-09-15');
    expect((await decisionOf(bootlegOnlyAlbum)).outcome).toBe('none');
  });

  it('an answer paid for again by another run is that run\'s own call; the next run reuses the latest', async () => {
    const d1 = fakeDecider(() => ({ A: 0.99 }));
    const r1 = await newRun();
    await deciderRunJob(ctx, { runId: r1 }, { decider: d1, apiKey: 'k' });
    // another requested model: nothing to reuse until the first answer pins the dated model, so the first album is paid for again
    const [{ id: r2 }] = await client`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, started_by_user_id)
                                      values (${lib}, 'jev', ${jevSpecHash()}, 'jev-other', 'needs_review', ${owner}) returning id`;
    const d2 = fakeDecider(() => ({ A: 0.99 }));
    const s2 = await deciderRunJob(ctx, { runId: r2 }, { decider: d2, apiKey: 'k' });
    expect(s2).toMatchObject({ state: 'done', billed: 1 });
    const own = await client`select local_album_id, cost::float8 as cost from decider_calls where run_id = ${r2}`;
    expect(own).toHaveLength(1);
    expect(own[0].cost).toBeCloseTo(0.001, 6);
    const again = own[0].local_album_id as string;
    // each run's spend counts only its own calls; the month counts both
    const spend = await runSpendByCurrency(client, [r1, r2]);
    const one = spend.get(r1)!.find((x) => x.currency === 'USD')!.amount;
    expect(one).toBeCloseTo(0.001 * d1.calls.length, 6);
    expect(spend.get(r2)).toEqual([{ currency: 'USD', amount: 0.001 }]);
    expect(await monthSpend(client, lib, 'USD')).toBeCloseTo(one + 0.001, 6);
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${r1} and local_album_id = ${again}`)[0].n).toBe(1);
    // a reused answer adds no row and no cost, and is the latest one for the key
    const r3 = await newRun();
    const d3 = fakeDecider(() => ({ A: 0.99 }));
    expect(await deciderRunJob(ctx, { runId: r3 }, { decider: d3, apiKey: 'k' })).toMatchObject({ state: 'done', billed: 0 });
    expect(d3.calls).toHaveLength(0);
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${r3}`)[0].n).toBe(0);
    const [{ call_id }] = await client`select call_id from decider_decisions where run_id = ${r3} and local_album_id = ${again}`;
    expect((await client`select run_id from decider_calls where id = ${call_id}`)[0].run_id).toBe(r2);
  });

  it('a crash resumes where it stopped and asks no album twice', async () => {
    let n = 0;
    const flaky = fakeDecider(() => (++n === 2 ? new JevUnavailable(503, 'HTTP 503') : { A: 0.99 }));
    const run = await newRun();
    await expect(deciderRunJob(ctx, { runId: run }, { decider: flaky, apiKey: 'k', lastAttempt: false })).rejects.toBeInstanceOf(JevUnavailable);
    // a retry follows: still running, the first album's decision kept
    expect((await client`select state from decider_runs where id = ${run}`)[0].state).toBe('running');
    const firstAlbum = flaky.calls[0]!.album.title;
    const s = await deciderRunJob(ctx, { runId: run }, { decider: flaky, apiKey: 'k' });
    expect(s.state).toBe('done');
    const titles = flaky.calls.map((c) => c.album.title);
    expect(titles.filter((t) => t === firstAlbum)).toHaveLength(1);
    // the album that failed is asked again on the retry, and only then
    expect(titles.filter((t) => t === titles[1])).toHaveLength(2);
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${run} and not possibly_billed`)[0].n).toBe(titles.length - 1);
    // the failed call may have been billed, once per request the client sent
    // (it does not say here: every attempt a run allows): kept at the estimate
    // times that, with no answer, and counted in the spend
    const maybe = await client`select cost::text, input_tokens, request_bytes, answers, decider_version from decider_calls where run_id = ${run} and possibly_billed`;
    expect(maybe).toHaveLength(1);
    expect(maybe[0]).toMatchObject({ answers: null, decider_version: 'jev-2026-09-15' });
    expect(Number(maybe[0].cost)).toBeGreaterThan(0);
    const [one] = await client`select request_bytes from decider_decisions where run_id = ${run} and local_album_id = (
                                 select local_album_id from decider_calls where run_id = ${run} and possibly_billed)`;
    expect(maybe[0].request_bytes).toBe(one.request_bytes * (RUN_MAX_RETRIES + 1));
    expect(maybe[0].input_tokens).toBe(Math.ceil(one.request_bytes * DEFAULT_TOKENS_PER_BYTE) * (RUN_MAX_RETRIES + 1));
    expect(Number(maybe[0].cost)).toBeCloseTo(maybe[0].input_tokens / 1e6, 6);
    const answered = (await client`select sum(cost)::float8 as c from decider_calls where run_id = ${run} and not possibly_billed`)[0].c;
    expect(await monthSpend(client, lib, 'USD')).toBeCloseTo(answered + Number(maybe[0].cost), 6);
  });

  it('a possibly billed call counts every request the client says it sent', async () => {
    const d = fakeDecider(() => new JevUnavailable(null, 'timed out', 3));
    const run = await newRun();
    await expect(deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', tokensPerByte: 1e-9 })).rejects.toBeInstanceOf(JevUnavailable);
    // each estimate is one token at 1 per million
    expect((await client`select input_tokens, cost::text from decider_calls where run_id = ${run} and possibly_billed`)).toEqual([{ input_tokens: 3, cost: '0.000003' }]);
  });

  it('a call rejected for a reason that cannot be billed (another 4xx) leaves no possibly billed row', async () => {
    const d = fakeDecider(() => new JevUnavailable(404, 'HTTP 404'));
    const run = await newRun();
    await expect(deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' })).rejects.toBeInstanceOf(JevUnavailable);
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${run}`)[0].n).toBe(0);
  });

  it('a second job on the same run while the first holds it does nothing and bills nothing', async () => {
    const run = await newRun();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let second: Awaited<ReturnType<typeof deciderRunJob>> | null = null;
    const other = fakeDecider(() => ({ A: 0.99 }));
    const d = fakeDecider(async () => {
      if (!second) {
        // the first job is mid-call: a retry of the same run arrives
        second = await deciderRunJob(ctx, { runId: run }, { decider: other, apiKey: 'k' });
        release();
      }
      await gate;
      return { A: 0.99 };
    });
    const first = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(second).toMatchObject({ state: 'running', billed: 0, reused: 0, decided: {} });
    expect(other.calls).toHaveLength(0);
    expect(first.state).toBe('done');
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${run}`)[0].n).toBe(d.calls.length);
    // the lock is let go with the job: the same session can take it again
    const conn = await client.reserve();
    try {
      expect((await conn`select pg_try_advisory_lock(${DECIDER_RUN_LOCK_NAMESPACE}::int, hashtext(${run})) as got`)[0].got).toBe(true);
      await conn`select pg_advisory_unlock(${DECIDER_RUN_LOCK_NAMESPACE}::int, hashtext(${run}))`;
    } finally {
      conn.release();
    }
  });

  it('a job whose time is up queues the rest of the run and leaves it running', async () => {
    let t = 0;
    const clock = () => (t++) * 1000;
    const run = await newRun();
    const d = fakeDecider(() => ({ A: 0.99 }));
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', clock, timeBudgetMs: 500 });
    expect(s.state).toBe('running');
    expect(send).toHaveBeenCalledWith('decider.run', { runId: run }, { singletonKey: `decider.run:${lib}` });
    expect((await client`select state from decider_runs where id = ${run}`)[0].state).toBe('running');
    expect((await client`select count(*)::int as n from decider_decisions where run_id = ${run}`)[0].n).toBe(1);
    // the queued job carries on where this one stopped
    const rest = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(rest.state).toBe('done');
    expect(new Set(d.calls.map((c) => c.album.title)).size).toBe(d.calls.length);
    // when the rest cannot be queued, the run is paused as stopped, so the owner can resume it
    send.mockImplementation(async () => null);
    const r2 = await newRun();
    t = 0;
    expect(await deciderRunJob(ctx, { runId: r2 }, { decider: d, apiKey: 'k', clock, timeBudgetMs: 500 })).toMatchObject({ state: 'paused', pauseReason: 'stopped' });
  });

  it('a job pg-boss has aborted stops before its next album, queues the rest and leaves the run running', async () => {
    const run = await newRun();
    const ac = new AbortController();
    // aborted mid-run (the worker is stopping): the album being asked finishes, the next is not started
    const d = fakeDecider(() => { ac.abort(); return { A: 0.99 }; });
    expect((await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', signal: ac.signal })).state).toBe('running');
    expect(d.calls).toHaveLength(1);
    expect(send).toHaveBeenCalledWith('decider.run', { runId: run }, { singletonKey: `decider.run:${lib}` });
    expect((await client`select state from decider_runs where id = ${run}`)[0].state).toBe('running');
    // the queued job finishes it, asking nothing twice
    expect((await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' })).state).toBe('done');
    expect(new Set(d.calls.map((c) => c.album.title)).size).toBe(d.calls.length);
    // when the rest cannot be queued, the run is paused as stopped
    send.mockImplementation(async () => null);
    const r2 = await newRun();
    const done = new AbortController();
    done.abort();
    expect(await deciderRunJob(ctx, { runId: r2 }, { decider: d, apiKey: 'k', signal: done.signal })).toMatchObject({ state: 'paused', pauseReason: 'stopped' });
    expect((await client`select state, pause_reason from decider_runs where id = ${r2}`)[0]).toEqual({ state: 'paused', pause_reason: 'stopped' });
  });

  it('a run left running with no job and no progress is paused as stopped, and resumes', async () => {
    const stale = await newRun();
    const busy = await newRunIn(lib2);
    const recent = await newRun();
    await client`update decider_runs set state = 'running', created_at = now() - interval '7 hours', started_at = now() - interval '7 hours'
                  where id in (${stale}, ${busy})`;
    await client`update decider_runs set state = 'running', started_at = now() where id = ${recent}`;
    // library 2 still has its job: its run is being worked
    await client`insert into pgboss.job (name, singleton_key, state) values ('decider.run', ${`decider.run:${lib2}`}, 'active'),
                 ('decider.run', ${`decider.run:${lib}`}, 'completed')`;
    expect(await pauseStaleRuns(client)).toEqual([stale]);
    expect((await client`select state, pause_reason, message from decider_runs where id = ${stale}`)[0])
      .toEqual({ state: 'paused', pause_reason: 'stopped', message: 'stopped: no progress' });
    expect((await client`select state from decider_runs where id in (${busy}, ${recent})`).map((r: any) => r.state)).toEqual(['running', 'running']);
    // a decider.run job sweeps its library first
    await client`update decider_runs set state = 'running', pause_reason = null where id = ${stale}`;
    await client`update decider_runs set state = 'cancelled' where id = ${recent}`;
    const d = fakeDecider(() => ({ A: 0.99 }));
    await deciderRunJob(ctx, { runId: recent }, { decider: d, apiKey: 'k' });
    expect((await client`select pause_reason from decider_runs where id = ${stale}`)[0].pause_reason).toBe('stopped');
    // the owner resumes it
    expect((await deciderRunJob(ctx, { runId: stale }, { decider: d, apiKey: 'k' })).state).toBe('done');
  });

  it('the last attempt that fails marks the run failed with a short label', async () => {
    const run = await newRun();
    const d = fakeDecider(() => new JevUnavailable(null, 'timed out'));
    await expect(deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', lastAttempt: true })).rejects.toBeInstanceOf(JevUnavailable);
    expect((await client`select state, message from decider_runs where id = ${run}`)[0]).toMatchObject({ state: 'failed', message: 'service unavailable' });
    expect((await client`select state, error from job_runs where subject_id = ${run} and type = 'decider.run'`)[0]).toMatchObject({ state: 'failed', error: 'service unavailable' });
  });

  it('a close second is none and keeps the album out of every band', async () => {
    await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 0.97, B: 0.8 })), apiKey: 'k' });
    expect(await decisionOf(albumA)).toMatchObject({ outcome: 'none', band: null, reason: 'margin' });
  });

  it('a group without an official edition is none (owner rule officialOnly)', async () => {
    await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 0.99 })), apiKey: 'k' });
    expect(await decisionOf(bootlegOnlyAlbum)).toMatchObject({ outcome: 'none', reason: 'no_official_edition', group_label: 'A' });
  });

  it('skips and lists an album over the size limit without calling', async () => {
    await setAutotaggerConfig(client, lib, { maxRequestBytes: 1024 });
    const d = fakeDecider(() => ({ A: 0.99 }));
    await deciderRunJob(ctx, { runId: await newRun() }, { decider: d, apiKey: 'k' });
    expect(d.calls.find((c) => c.album.title === 'Grosses Werk')).toBeUndefined();
    const dec = await decisionOf(hugeAlbum);
    expect(dec.outcome).toBe('too_large');
    expect(dec.reason).toMatch(/^\d+ bytes$/);
  });

  it('a rejected request is recorded and the run carries on; the service text is not kept', async () => {
    const d = fakeDecider((i) => (i.album.title === 'Lichtung' ? new JevRejected(422, 'too large: Ilta Aamu') : { A: 0.99 }));
    const run = await newRun();
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s.state).toBe('done');
    expect(s.decided['rejected']).toBe(1);
    const [rej] = await client`select reason from decider_decisions where run_id = ${run} and outcome = 'rejected'`;
    expect(rej.reason).toBe('HTTP 422');
  });

  it('pauses at the cap with the spend in its message, and resumes where it stopped', async () => {
    // one call costs 0.001 (1,000 tokens at 1 per million); every estimate is one token
    await setAutotaggerConfig(client, lib, { monthlyCap: 0.001 });
    const run = await newRun();
    const d = fakeDecider(() => ({ A: 0.99 }));
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', tokensPerByte: 1e-9, checkEvery: 1 });
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'cap_reached', billed: 1 });
    expect((await client`select state, pause_reason, message from decider_runs where id = ${run}`)[0])
      .toMatchObject({ state: 'paused', pause_reason: 'cap_reached', message: 'spent 0.0010 of 0.001 USD' });
    const population = (await populationAlbumIds(client, lib, 'needs_review')).length;
    const decidedSoFar = (await client`select count(*)::int as n from decider_decisions where run_id = ${run}`)[0].n;
    // the progress row keeps how far the run got
    const [paused] = await client`select state, progress from job_runs where subject_id = ${run}`;
    expect(paused).toMatchObject({ state: 'completed', progress: { done: decidedSoFar, total: population, message: 'paused: cap_reached' } });
    // an album decided before the pause leaves the queue: it no longer counts as done
    const [left] = await client`select local_album_id as id from decider_decisions where run_id = ${run} limit 1`;
    await client`update local_albums set state = 'matched' where id = ${left.id}`;
    await setAutotaggerConfig(client, lib, { monthlyCap: 10 });
    const again = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', tokensPerByte: 1e-9 });
    await client`update local_albums set state = 'needs_review' where id = ${left.id}`;
    expect(again.state).toBe('done');
    const [last] = await client`select state, progress from job_runs where subject_id = ${run} order by started_at desc limit 1`;
    expect(last).toMatchObject({ state: 'completed', progress: { done: population - 1, total: population - 1 } });
    expect(new Set(d.calls.map((c) => c.album.title)).size).toBe(d.calls.length);
    expect((await client`select pause_reason, message from decider_runs where id = ${run}`)[0]).toEqual({ pause_reason: null, message: null });
  });

  it('pauses when the module is off, without a key, cap or price, and when the key is refused', async () => {
    await setAutotaggerEnabled(client, false);
    expect((await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 1 })) })).pauseReason).toBe('module_off');
    await setAutotaggerEnabled(client, true);
    expect((await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 1 })) })).pauseReason).toBe('no_key');
    const refused = fakeDecider(() => new JevKeyRefused(401));
    const run = await newRun();
    expect((await deciderRunJob(ctx, { runId: run }, { decider: refused, apiKey: 'k' })).pauseReason).toBe('key_refused');
    expect((await client`select message from decider_runs where id = ${run}`)[0].message).toBe('key refused (HTTP 401)');

    await setAutotaggerConfig(client, lib, { monthlyCap: null });
    expect((await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 1 })), apiKey: 'k' })).pauseReason).toBe('no_cap');
    await setAutotaggerConfig(client, lib, { monthlyCap: 10 });
    await client`delete from decider_prices where decider_id = 'jev'`;
    const noPrice = fakeDecider(() => ({ A: 1 }));
    expect((await deciderRunJob(ctx, { runId: await newRun() }, { decider: noPrice, apiKey: 'k' })).pauseReason).toBe('no_price');
    expect(noPrice.calls).toHaveLength(0);
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev', '*', 1, 'EUR')`;
    expect((await deciderRunJob(ctx, { runId: await newRun() }, { decider: noPrice, apiKey: 'k' })).pauseReason).toBe('currency_mismatch');
    expect(noPrice.calls).toHaveLength(0);
  });

  it('an answer priced in another currency than the cap is recorded, then the run pauses', async () => {
    await client`insert into decider_prices (decider_id, model, per_million_input, currency) values ('jev', 'jev-2026-09-15', 2, 'EUR')`;
    const run = await newRun();
    const d = fakeDecider(() => ({ A: 0.99 }));
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'currency_mismatch', billed: 1 });
    expect((await client`select currency, cost::text from decider_calls where run_id = ${run}`)).toEqual([{ currency: 'EUR', cost: '0.002000' }]);
    expect((await client`select message from decider_runs where id = ${run}`)[0].message).toBe('price EUR, cap USD');
    expect(d.calls).toHaveLength(1);
  });

  it('pauses when an answer names another model than the one the run is pinned to', async () => {
    const d = fakeDecider(() => ({ A: 0.99 }), (n) => (n === 1 ? 'jev-2026-09-15' : 'jev-2026-10-01'));
    const run = await newRun();
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'model_changed', billed: 2 });
    expect((await client`select decider_version, message from decider_runs where id = ${run}`)[0])
      .toEqual({ decider_version: 'jev-2026-09-15', message: 'model changed: jev-2026-10-01' });
    // the answer is kept under the model that gave it, and nothing was decided on it
    const versions = (await client`select decider_version from decider_calls where run_id = ${run} order by created_at`).map((r: any) => r.decider_version);
    expect(versions).toEqual(['jev-2026-09-15', 'jev-2026-10-01']);
    expect((await client`select count(*)::int as n from decider_decisions where run_id = ${run} and call_id is not null`)[0].n).toBe(1);
  });

  it('a second library uses its own key and settings', async () => {
    vi.stubEnv('APP_SECRET', SECRET);
    await setTypesafeKey(client, lib, sealSecret('ts-test-key-0001', SECRET), '0001');
    const own = await deciderRunJob(ctx, { runId: await newRun() }, { decider: fakeDecider(() => ({ A: 1 })) });
    expect(own.state).toBe('done');
    // library 2 has no key
    expect((await deciderRunJob(ctx, { runId: await newRunIn(lib2) }, { decider: fakeDecider(() => ({ A: 1 })) })).pauseReason).toBe('no_key');
    // with a key of its own it still has no cap: library 1's cap is not its
    await setTypesafeKey(client, lib2, sealSecret('ts-test-key-0002', SECRET), '0002');
    expect((await deciderRunJob(ctx, { runId: await newRunIn(lib2) }, { decider: fakeDecider(() => ({ A: 1 })) })).pauseReason).toBe('no_cap');
    vi.unstubAllEnvs();
  });

  it('weak population: unidentified albums with weak candidates, top five sent', async () => {
    const d = fakeDecider(() => ({ A: 0.2 }));
    const run = await newRun('weak');
    await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(d.calls.map((c) => c.album.title)).toEqual(['Schwach']);
    const c = d.calls[0]!;
    expect(c.groups.flatMap((g) => g.members)).toHaveLength(5);
    expect(await decisionOf(weakAlbum)).toMatchObject({ outcome: 'none', reason: 'invalid_answer' });
  });

  it('a cancelled run stops at its next check', async () => {
    const run = await newRun();
    const d = fakeDecider(async () => { await client`update decider_runs set state = 'cancelled' where id = ${run}`; return { A: 0.99 }; });
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', checkEvery: 1 });
    expect(s.state).toBe('cancelled');
    expect(d.calls).toHaveLength(1);
    expect((await client`select state from decider_runs where id = ${run}`)[0].state).toBe('cancelled');
  });

  it('a cancel stops the run before its next paid call, between checks too', async () => {
    const run = await newRun();
    const d = fakeDecider(async () => { await client`update decider_runs set state = 'cancelled' where id = ${run}`; return { A: 0.99 }; });
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', checkEvery: 1000 });
    expect(s.state).toBe('cancelled');
    expect(d.calls).toHaveLength(1);
    expect((await client`select count(*)::int as n from decider_calls where run_id = ${run}`)[0].n).toBe(1);
  });

  it('sends exactly the request the payload preview shows for the album and model', async () => {
    const d = fakeDecider(() => ({ A: 0.995, B: 0.1 }));
    const run = await newRun();
    await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    // the first call asks for the configured model; the rest, the dated model it pinned
    const model = (c: DeciderInput) => (c.payload as { model: string }).model;
    expect(model(d.calls[0]!)).toBe('jev-latest');
    const config = { model: '', maxRequestBytes: null };
    const sent = d.calls.find((c) => c.album.title === 'Kuunvalo')!;
    const ev = (await loadEvidence(client, albumA))!;
    // the preview's own call: the Jev builder, with the run's options
    const shown = requestForAlbum(ev.album, ev.candidates, requestOptions('needs_review', { ...config, model: model(sent) }, ev));
    expect(sent.payload).toEqual(shown.request);
    expect(JSON.stringify(sent.payload)).toBe(JSON.stringify(shown.request));
    expect((await client`select request_bytes from decider_decisions where run_id = ${run} and local_album_id = ${albumA}`)[0].request_bytes).toBe(shown.bytes);

    // a weak album: its best five candidates, as its preview shows
    const w = fakeDecider(() => ({ A: 0.2 }));
    await deciderRunJob(ctx, { runId: await newRun('weak') }, { decider: w, apiKey: 'k' });
    const weakSent = w.calls.find((c) => c.album.title === 'Schwach')!;
    const weakEv = (await loadEvidence(client, weakAlbum))!;
    const weakShown = requestForAlbum(weakEv.album, weakEv.candidates, requestOptions('weak', { ...config, model: model(weakSent) }, weakEv));
    expect(JSON.stringify(weakSent.payload)).toBe(JSON.stringify(weakShown.request));
    expect(Object.keys(weakShown.request.questions)).toHaveLength(5);
  });

  it('asks nothing before the owner has seen the payload', async () => {
    await client`update decider_library_settings set config = config - 'payloadSeenAt' - 'payloadSeenBy' where library_id = ${lib}`;
    const d = fakeDecider(() => ({ A: 1 }));
    const run = await newRun();
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k' });
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'payload_not_seen' });
    expect(d.calls).toHaveLength(0);
    expect((await client`select state, pause_reason from decider_runs where id = ${run}`)[0]).toEqual({ state: 'paused', pause_reason: 'payload_not_seen' });
  });

  it('a run paused from elsewhere mid-run reports itself paused, not cancelled', async () => {
    const run = await newRun();
    const d = fakeDecider(async () => {
      await client`update decider_runs set state = 'paused', pause_reason = 'stopped' where id = ${run}`;
      return { A: 0.99 };
    });
    const s = await deciderRunJob(ctx, { runId: run }, { decider: d, apiKey: 'k', checkEvery: 1000 });
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'stopped' });
    expect(d.calls).toHaveLength(1);
  });

  it('a run whose question spec changed is paused, asking nothing', async () => {
    const [r] = await client`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population)
                             values (${lib}, 'jev', 'tagave-tracklist-v0@000000000000', 'jev-latest', 'needs_review') returning id`;
    const d = fakeDecider(() => ({ A: 1 }));
    expect((await deciderRunJob(ctx, { runId: r.id }, { decider: d, apiKey: 'k' })).pauseReason).toBe('spec_changed');
    expect(d.calls).toHaveLength(0);
  });

  it('measure population: the largest albums, then a seeded sample of the rest', async () => {
    const all = await populationAlbumIds(client, lib, 'needs_review');
    const m = await populationAlbumIds(client, lib, 'measure', { sample: 2, largest: 1, seed: 7 });
    expect(m).toHaveLength(3);
    expect(new Set(m).size).toBe(3);
    expect(m.every((id) => all.includes(id))).toBe(true);
    expect(await populationAlbumIds(client, lib, 'measure', { sample: 2, largest: 1, seed: 7 })).toEqual(m);
    expect(await populationAlbumIds(client, lib, 'measure', { sample: 100, largest: 1 })).toHaveLength(all.length);
  });

  /**
   * A fake whose request is always 1000 bytes: with tokensPerByte 1 every estimate is 1000 tokens
   * (0.002 at 2 per million), whatever the album, so the spend limits below are deterministic.
   */
  const fixedSize = () => {
    const d = fakeDecider(() => ({ A: 0.99 }));
    return Object.assign(d, { build: ((...a: Parameters<typeof jevPayloadFor>) => ({ ...jevPayloadFor(...a), bytes: 1000 })) as typeof jevPayloadFor });
  };
  const measureDeps = (d: Decider, over: Record<string, unknown> = {}) => ({
    decider: d, apiKey: 'k', tokensPerByte: 1, price: { perMillionInput: 2, currency: 'USD' }, payloadApproved: true, ...over,
  });

  it('a measurement uses the given price, stops at its own spend limit and writes no match', async () => {
    await setAutotaggerEnabled(client, false); // a restored copy has the module off
    const run = await newRun('measure');
    const s = await deciderRunJob(ctx, { runId: run }, measureDeps(fixedSize(), { maxSpend: 0.0035 }));
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'cap_reached' });
    expect(s.billed).toBe(1); // 0.002 billed; the next estimate would pass 0.0035
    const [{ c }] = await client`select sum(cost)::float as c from decider_calls where run_id = ${run}`;
    expect(c).toBeCloseTo(0.002, 6);
    expect(await client`select 1 from album_matches where batch_id is not null or decided_kind = 'model'`).toHaveLength(0);
    expect(await client`select 1 from decider_batches`).toHaveLength(0);
  });

  it('a measurement counts a possibly billed call of its own run towards its limit, and in its own currency', async () => {
    const run = await newRun('measure');
    const album = albumA;
    await client`insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version,
                                            request_bytes, input_tokens, cost, currency, answers, possibly_billed)
                 values (${lib}, ${album}, ${run}, 'x', ${jevSpecHash()}, 'jev', 'jev-2026-09-15', 1000, 1000, 0.002, 'EUR', null, true)`;
    // 0.002 already spent + a 0.002 estimate is over 0.0035: nothing is asked
    const d = fixedSize();
    const s = await deciderRunJob(ctx, { runId: run }, measureDeps(d, { maxSpend: 0.0035, price: { perMillionInput: 2, currency: 'EUR' } }));
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'cap_reached', billed: 0 });
    expect(d.calls).toHaveLength(0);
  });

  it('a measurement on a copy that never showed the payload pauses unless the owner approved it', async () => {
    await client`update decider_library_settings set config = config - 'payloadSeenAt' - 'payloadSeenBy' where library_id = ${lib}`;
    const blocked = fixedSize();
    const run = await newRun('measure');
    expect(await deciderRunJob(ctx, { runId: run }, measureDeps(blocked, { payloadApproved: undefined, maxSpend: 0.0035 })))
      .toMatchObject({ state: 'paused', pauseReason: 'payload_not_seen' });
    expect(blocked.calls).toHaveLength(0);
    const allowed = fixedSize();
    const s = await deciderRunJob(ctx, { runId: run }, measureDeps(allowed, { maxSpend: 0.0035 }));
    expect(s).toMatchObject({ state: 'paused', pauseReason: 'cap_reached', billed: 1 });
    expect(allowed.calls).toHaveLength(1);
  });

  it('a measurement without its own spend limit never calls', async () => {
    const d = fixedSize();
    const run = await newRun('measure');
    expect(await deciderRunJob(ctx, { runId: run }, measureDeps(d, { maxSpend: undefined })))
      .toMatchObject({ state: 'paused', pauseReason: 'no_cap' });
    expect(d.calls).toHaveLength(0);
  });

  it('a run of another population ignores a given price, spend limit and payload approval', async () => {
    await client`update decider_library_settings set config = config - 'payloadSeenAt' - 'payloadSeenBy' where library_id = ${lib}`;
    const run = await newRun('needs_review');
    const d = fixedSize();
    expect(await deciderRunJob(ctx, { runId: run }, measureDeps(d, { maxSpend: 0.0001 }))).toMatchObject({ pauseReason: 'payload_not_seen' });
    await markPayloadSeen(client, lib, owner);
    await setAutotaggerEnabled(client, false);
    expect(await deciderRunJob(ctx, { runId: run }, measureDeps(d, { maxSpend: 0.0001 }))).toMatchObject({ pauseReason: 'module_off' });
    await setAutotaggerEnabled(client, true);
    const s = await deciderRunJob(ctx, { runId: run }, measureDeps(d, { maxSpend: 0.0001, price: { perMillionInput: 1000, currency: 'USD' } }));
    expect(s.state).toBe('done'); // the limit of 0.0001 and the price of 1000 were not used
    const [{ c }] = await client`select max(cost)::float as c from decider_calls where run_id = ${run}`;
    expect(c).toBeCloseTo(0.001, 6); // the table price (1 per million) priced the 1000 tokens
  });
});

/**
 * The measurement tool against a real database, with a fake decider
 * (nothing leaves the machine): a measure run over the review queue that
 * reports cost and request size and decides nothing in the library, the
 * preview of one album's request, and the command line's refusals. The key
 * read from stdin appears in no output.
 *
 * On a scratch database, as decider.run's own tests: a run reads the
 * library's whole autotagger config.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import pino from 'pino';
import { autotaggerEnabled, makeDb, markPayloadSeen, runMigrations, setAutotaggerEnabled, syncInstalledModules } from '@tagave/db';
import { buildAlbumEvidence, buildCandidateEvidence, jevPayloadFor, jevSpecHash, requestBytes, type Decider, type JevRequest } from '@tagave/core';
import { ledgerEntries } from '@tagave/core/facets';
import type { WorkerContext } from './lib/context.js';
import { upsertAlbumEvidence } from './lib/evidenceStore.js';
import { JevRejected, JevUnavailable } from './lib/jevClient.js';
import { measure, previewOne, reportFor, runCli } from './autotaggerMeasure.js';

const LIMIT_BYTES = 3000;

/** Answers { A: 0.99 } at 10 tokens a track, and rejects (422) any request over 3,000 bytes. */
function fakeDecider(): Decider & { asked: number } {
  const d = {
    id: 'jev', specHash: jevSpecHash(), build: jevPayloadFor, asked: 0,
    async ask(input: Parameters<Decider['ask']>[0]) {
      d.asked += 1;
      const bytes = requestBytes(input.payload as JevRequest);
      if (bytes > LIMIT_BYTES) throw new JevRejected(422, 'too big');
      return { probabilities: { A: 0.99 }, model: 'jev-2026-09-15', inputTokens: 10 * input.album.tracks.length, requestBytes: bytes, raw: {} };
    },
  };
  return d;
}

/** A writable that keeps what is written. */
function sink(): { write: (s: string) => boolean; text: () => string } {
  let out = '';
  return { write: (s: string) => { out += s; return true; }, text: () => out };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('autotaggerMeasure (scratch db)', () => {
  let admin: postgres.Sql;
  let client: any;
  let ctx: WorkerContext;
  let url = '';
  const name = `tagave_mstest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const owner = randomUUID();
  const lib = randomUUID();
  const cliLib = randomUUID();
  const spareLib = randomUUID();
  const spare: string[] = [];
  const rg = randomUUID();
  const albums: string[] = [];
  let weakAlbum = '';
  const send = vi.fn(async () => 'job');
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  async function makeAlbum(libraryId: string, title: string, tracks: number, o: { state?: string; reason?: string } = {}): Promise<string> {
    const id = randomUUID();
    const titles = Array.from({ length: tracks }, (_, i) => `${title} osa ${i + 1}`);
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, title_source, last_identify_at)
                 values (${id}, ${libraryId}, ${'k-' + id}, ${['x/' + id]}, ${title}, 'Kuunvalo', ${o.state ?? 'needs_review'}, ${o.reason ?? 'close call'},
                         ${tracks}, 'tag', now())`;
    await upsertAlbumEvidence(client, id, buildAlbumEvidence({
      artist: 'Kuunvalo', title, titleSource: 'tag', year: 2001, yearSource: 'tag', discsKnown: false, discCount: null,
      tracks: titles.map((t, i) => ({ title: t, titleSource: 'tag' as const, duration: 200 + i * 10 })),
    }));
    const rid = randomUUID();
    await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                 values (${rid}, ${rg}, ${randomUUID()}, ${title}, 'Official', ${tracks}, 'musicbrainz')`;
    const ev = buildCandidateEvidence(
      { source: 'musicbrainz', title, artists: ['Kuunvalo'], status: 'Official', tracks: titles.map((t, i) => ({ title: t, duration: 200 + i * 10 })) },
      { alignment: titles.map((_, i) => ({ localIndex: i, canonicalIndex: i, distance: 0.01, title: { local: '' }, duration: { local: 0 } })), missingRemote: [] },
      tracks);
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence, excluded)
                 values (${id}, ${rid}, 0.05, '{}'::jsonb, 'mb_search', ${JSON.stringify(ev)}::text::jsonb, false)`;
    return id;
  }

  beforeAll(async () => {
    admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url, { log: () => undefined });
    const made = await makeDb(url);
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(client, ledgerEntries());
    await client`insert into users (id, email, password_hash) values (${owner}, ${`ms-${owner}@test.com`}, 'x')`;
    for (const id of [lib, cliLib, spareLib]) await client`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${owner}, 'Measure', '{}'::jsonb)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Kuunvalo', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;
    // 12 albums in review, 2 of them large; one weak album outside the measurement
    for (let i = 0; i < 10; i++) albums.push(await makeAlbum(lib, `Pieni ${i}`, 3));
    for (let i = 0; i < 2; i++) albums.push(await makeAlbum(lib, `Suuri ${i}`, 40));
    weakAlbum = await makeAlbum(lib, 'Heikko', 3, { state: 'unidentified', reason: 'weak_candidates' });
    await markPayloadSeen(client, lib, owner);
    // the command-line library: a restored copy with no record of the payload being seen
    for (let i = 0; i < 3; i++) await makeAlbum(cliLib, `Kopio ${i}`, 3);
    // albums no other test asks about, so no stored answer stands in for a call
    for (let i = 0; i < 2; i++) spare.push(await makeAlbum(spareLib, `Vara ${i}`, 3));
    await markPayloadSeen(client, spareLib, owner);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  }, 120_000);

  afterEach(() => {
    // nothing ever goes to the network
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    fetchSpy?.mockRestore();
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('reports cost per album and the projection for the whole queue, and decides nothing in the library', async () => {
    const decider = fakeDecider();
    const r = await measure(ctx, { libraryId: lib, sample: 10, largest: 2, model: 'jev-latest', price: { perMillionInput: 1, currency: 'USD' }, maxSpend: 1 }, { decider, apiKey: 'k' });
    expect(r.albumsSent).toBe(12);
    expect(r.outcomes['rejected']).toBe(2);
    expect(r.requestBytes.smallestRejected).toBeGreaterThan(3000);
    expect(r.recommendedMaxRequestBytes).toBe(r.requestBytes.smallestRejected! - 1);
    expect(r.costPerAlbum.mean).toBeGreaterThan(0);
    expect(r.projected.needsReview).toBeCloseTo(r.costPerAlbum.mean * r.queue.needsReview, 6);
    expect(await client`select 1 from album_matches where local_album_id = any(${albums}::uuid[])`).toHaveLength(0);
    expect((await client`select count(*)::int as n from local_albums where id = any(${albums}::uuid[]) and state = 'needs_review'`)[0].n).toBe(12);

    // the statistics, from the run's own calls
    expect(r.outcomes['pick']).toBe(10);
    expect(r.inputTokens).toEqual({ mean: 30, median: 30, p95: 30, max: 30 });
    expect(r.costPerAlbum.mean).toBeCloseTo(0.00003, 9);
    expect(r.spent).toBeCloseTo(0.0003, 9);
    expect(r.currency).toBe('USD');
    expect(r.queue).toEqual({ needsReview: 12, weak: 1 });
    expect(r.projected.withWeak).toBeCloseTo(r.costPerAlbum.mean * 13, 9);
    expect(r.requestBytes.largestAccepted).toBeLessThanOrEqual(LIMIT_BYTES);
    expect(r.requestBytes.rejected).toHaveLength(2);
    expect(r.model).toBe('jev-2026-09-15');
    expect(r.state).toBe('done');
    expect((await client`select population, spec_hash from decider_runs where id = ${r.runId}`)[0]).toEqual({ population: 'measure', spec_hash: jevSpecHash() });
    expect((await client`select state from local_albums where id = ${weakAlbum}`)[0].state).toBe('unidentified');
  });

  it('leaves possibly billed calls out of the token figures but counts them as spent', async () => {
    const decider = fakeDecider();
    const r = await measure(ctx, { libraryId: spareLib, sample: 2, largest: 0, model: 'jev-latest', price: { perMillionInput: 1, currency: 'USD' }, maxSpend: 1 }, { decider, apiKey: 'k' });
    await client`insert into decider_calls (library_id, local_album_id, run_id, evidence_hash, spec_hash, decider_id, decider_version,
                                            request_bytes, input_tokens, cost, currency, answers, possibly_billed)
                 values (${spareLib}, ${spare[0]}, ${r.runId}, ${'x'.repeat(64)}, ${jevSpecHash()}, 'jev', 'jev-2026-09-15', 9000, 9000, 0.5, 'USD', null, true)`;
    const again = await reportFor(ctx, r.runId, spareLib, 'USD');
    expect(r.inputTokens.max).toBe(30);
    expect(again.inputTokens).toEqual(r.inputTokens);
    expect(again.spent).toBeCloseTo(r.spent + 0.5, 6);
  });

  it('preview prints one album\'s request and calls nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const p = await previewOne(ctx, lib, 'jev-latest');
    expect(p!.request.questions).toHaveProperty('is_A');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preview of a named album is the request the measurement sends for it', async () => {
    const p = await previewOne(ctx, lib, 'jev-latest', albums[0]);
    expect(p!.albumId).toBe(albums[0]);
    expect(p!.bytes).toBe(requestBytes(p!.request));
    // an album outside the review queue is not one a measurement sends
    expect(await previewOne(ctx, lib, 'jev-latest', weakAlbum)).toBeNull();
    expect(await previewOne(ctx, cliLib, 'jev-latest', albums[0])).toBeNull();
  });

  describe('command line', () => {
    const KEY = 'tsk-live-9f8e7d6c5b4a39281706';
    const full = (dbName: string, json?: string) => [
      'measure', '--library', cliLib, '--price-per-mtok', '1', '--currency', 'USD', '--max-spend', '1',
      '--sample', '5', '--largest', '1', '--key-stdin', '--payload-approved', '--confirm-database', dbName, ...(json ? ['--json', json] : []),
    ];
    const io = (over: { decider?: Decider } = {}) => {
      const stdout = sink(); const stderr = sink();
      return {
        stdout, stderr,
        cli: {
          stdout, stderr, env: { DATABASE_URL: url }, readStdin: async () => `  ${KEY}\n`,
          ...(over.decider ? { deciderFor: () => over.decider! } : {}),
        },
      };
    };
    const runs = async () => (await client`select count(*)::int as n from decider_runs where library_id = ${cliLib}`)[0].n as number;

    it('refuses without each required flag, with exit code 2, writing nothing', async () => {
      const args = full(name);
      for (const flag of ['--key-stdin', '--price-per-mtok', '--currency', '--max-spend', '--payload-approved', '--confirm-database']) {
        const at = args.indexOf(flag);
        const without = [...args.slice(0, at), ...args.slice(at + (flag.startsWith('--key') || flag === '--payload-approved' ? 1 : 2))];
        const t = io({ decider: fakeDecider() });
        expect(await runCli(without, t.cli), flag).toBe(2);
        expect(t.stderr.text()).toMatch(/usage|required/);
      }
      expect(await runs()).toBe(0);
    });

    it('never takes the key from the command line', async () => {
      const t = io({ decider: fakeDecider() });
      expect(await runCli([...full(name), '--key', KEY], t.cli)).toBe(2);
      expect(t.stdout.text() + t.stderr.text()).not.toContain(KEY);
      expect(await runs()).toBe(0);
    });

    it('refuses a database other than the one confirmed, before writing anything', async () => {
      const t = io({ decider: fakeDecider() });
      expect(await runCli(full('tagave'), t.cli)).toBe(2);
      expect(t.stderr.text()).toContain('database');
      expect(await runs()).toBe(0);
    });

    it('refuses a database with the autotagger on (a restored copy has it off), before writing anything', async () => {
      expect(await autotaggerEnabled(client)).toBe(false);
      await setAutotaggerEnabled(client, true);
      try {
        const t = io({ decider: fakeDecider() });
        expect(await runCli(full(name), t.cli)).toBe(2);
        expect(t.stderr.text()).toContain('autotagger is on');
        expect(await runs()).toBe(0);
      } finally {
        await setAutotaggerEnabled(client, false);
      }
    });

    it('a measurement that fails prints what its run spent, possibly billed calls included', async () => {
      const down: Decider = { ...fakeDecider(), async ask() { throw new JevUnavailable(503, `down for ${KEY}`, 2); } };
      const t = io({ decider: down });
      // another model, so no stored answer stands in for the call
      expect(await runCli([...full(name), '--model', 'jev-down'], t.cli)).toBe(1);
      const err = t.stderr.text();
      const [, runId, spent] = err.match(/measurement stopped: run ([0-9a-f-]{36}), spent ([\d.]+) USD/) ?? [];
      expect(Number(spent)).toBeGreaterThan(0);
      const [{ c, state }] = await client`select (select sum(cost)::float8 from decider_calls where run_id = r.id) as c, r.state from decider_runs r where r.id = ${runId}`;
      expect(Number(spent)).toBeCloseTo(c, 6);
      expect(state).toBe('failed');
      expect(t.stdout.text() + err).not.toContain(KEY);
    });

    it('a connection failure goes through the same scrubbed path', async () => {
      const t = io({ decider: fakeDecider() });
      t.cli.env = { DATABASE_URL: `postgres://nobody:${KEY}@127.0.0.1:1/none` };
      expect(await runCli(full(name), t.cli)).toBe(1);
      expect(t.stdout.text() + t.stderr.text()).not.toContain(KEY);
    });

    it('measures, writes the JSON report, and the key appears in no output', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tagave-measure-'));
      try {
        const json = join(dir, 'report.json');
        const t = io({ decider: fakeDecider() });
        expect(await runCli(full(name, json), t.cli)).toBe(0);
        const out = t.stdout.text();
        expect(out).toContain('albums sent: 3 (reused: 0)');
        expect(out).toContain('cost per album (USD)');
        expect(out).toContain('with weak (upper bound)');
        const written = await readFile(json, 'utf8');
        const report = JSON.parse(written);
        expect(report.albumsSent).toBe(3);
        // statistics only: no request bodies
        expect(written).not.toContain('questions');
        expect(written).not.toContain('Kopio');
        for (const text of [out, t.stderr.text(), written]) expect(text).not.toContain(KEY);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps the key out of an error it prints', async () => {
      const leaky: Decider = { ...fakeDecider(), async ask() { throw new Error(`bad header: Bearer ${KEY} for ${KEY}`); } };
      const t = io({ decider: leaky });
      // another model, so no stored answer stands in for the call
      expect(await runCli([...full(name), '--model', 'jev-leak'], t.cli)).toBe(1);
      expect(t.stderr.text()).toContain('[redacted]');
      expect(t.stdout.text() + t.stderr.text()).not.toContain(KEY);
    });

    it('preview runs on a read-only connection and prints the request', async () => {
      const t = io();
      expect(await runCli(['preview', '--library', lib, '--album', albums[0]!], t.cli)).toBe(0);
      expect(JSON.parse(t.stdout.text().slice(t.stdout.text().indexOf('{'))).questions).toHaveProperty('is_A');
    });
  });
});

/**
 * decider.train against a real database: the dataset is read from the
 * library's live matches and candidates (excluded and linked-app candidates
 * never, each release once), the model is trained, stored as the library's
 * one active model, the same data stores the same version, and nothing is
 * stored while the module is off or with too few owner decisions. The
 * command line tool trains the same way and stores nothing on a dry run.
 *
 * On a scratch database: the job needs the module switched on, and the
 * shared test database's switch belongs to every suite running at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import pino from 'pino';
import { activeModel, listModels, makeDb, runMigrations, setAutotaggerEnabled, syncInstalledModules } from '@tagave/db';
import { buildAlbumEvidence, buildCandidateEvidence, calibratedProbability, candidateFeatures, modelVersion, type LocalModel, type LocalTrainMetrics } from '@tagave/core';
import { ledgerEntries } from '@tagave/core/facets';
import type { WorkerContext } from '../lib/context.js';
import { upsertAlbumEvidence } from '../lib/evidenceStore.js';
import { deciderTrainJob, loadTrainingAlbums } from './deciderTrain.js';
import { runCli } from '../localDeciderTrain.js';

/** A small seeded generator, so the library is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER_ALBUMS = 150;
const AUTO_ALBUMS = 50;
/** The test library is smaller than a real one needs to be. */
const MIN = 100;

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.train (scratch db)', () => {
  let admin: postgres.Sql;
  let client: any;
  let url = '';
  let ctx: WorkerContext;
  const name = `tagave_dttest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const user = randomUUID();
  const lib = randomUUID();
  const otherLib = randomUUID();
  const rgLabel = randomUUID();
  const rgOther = randomUUID();
  /** album → its label release, and the special cases */
  const labelOf = new Map<string, string>();
  let excludedLabelAlbum = '', dupAlbum = '', dupRelease = '', rejectedAuto = '', rejectedRelease = '', mcRelease = '', excludedRelease = '';

  const out = () => { let s = ''; return { write: (x: string) => { s += x; }, get text() { return s; } }; };

  /** One album: a near label candidate and two far ones; owner albums get stored evidence. */
  async function album(libraryId: string, i: number, kind: 'owner' | 'auto', r: () => number, extra: { excludedLabel?: boolean } = {}) {
    const id = randomUUID();
    await client`insert into local_albums (id, library_id, cluster_key, state) values (${id}, ${libraryId}, ${`k-${id}`}, 'matched')`;
    const tracks = [`Eka ${i}`, `Toka ${i}`, `Kolmas ${i}`];
    if (kind === 'owner') {
      await upsertAlbumEvidence(client, id, buildAlbumEvidence({
        artist: 'Testi', title: `Albumi ${i}`, titleSource: 'tag', year: 2001, yearSource: 'tag', discsKnown: false, discCount: null,
        tracks: tracks.map((t, k) => ({ title: t, titleSource: 'tag' as const, duration: 200 + k * 30 })),
      }));
    }
    const releases: string[] = [];
    for (let j = 0; j < 3; j++) {
      const rid = randomUUID();
      releases.push(rid);
      const near = j === 0;
      await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                   values (${rid}, ${near ? rgLabel : rgOther}, ${randomUUID()}, ${`Albumi ${i}`}, 'Official', 3, ${j === 2 ? 'discogs' : 'musicbrainz'})`;
      // the far ones have another tracklist each, so every candidate is its own group
      const titles = near ? tracks : tracks.map((t) => `${t} muu ${j}`);
      const ev = buildCandidateEvidence(
        { source: 'musicbrainz', title: `Albumi ${i}`, artists: ['Testi'], status: 'Official', tracks: titles.map((t, k) => ({ title: t, duration: 200 + k * 30 })) },
        { alignment: tracks.map((_, k) => ({ localIndex: k, canonicalIndex: k, distance: near ? 0 : 0.4, title: { local: '' }, duration: { local: 0 } })), missingRemote: [] },
        3);
      const distance = (near ? r() * 0.08 : 0.3 + r() * 0.4).toFixed(4);
      const breakdown = { album: near ? r() * 0.05 : 0.2 + r() * 0.5, tracks: near ? 0 : r() * 0.5 };
      await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence, acoustid_coverage, excluded)
                   values (${id}, ${rid}, ${distance}, ${JSON.stringify(breakdown)}::text::jsonb, 'mb_search', ${JSON.stringify(ev)}::text::jsonb,
                           ${(near ? 0.8 + r() * 0.2 : r() * 0.3).toFixed(4)}, ${near && extra.excludedLabel === true})`;
    }
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind)
                 values (${libraryId}, ${id}, ${releases[0]}, 0.01, ${kind === 'owner' ? 'confirmed' : 'auto'}, ${kind === 'owner' ? 'user' : 'system'},
                         ${kind === 'owner' ? 'user' : 'system'})`;
    labelOf.set(id, releases[0]!);
    return { id, releases };
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
    ctx = { db: made.db, sql: made.client, boss: { send: async () => null } as any, logger: pino({ level: 'silent' }) };
    await syncInstalledModules(client, ledgerEntries());
    await client`insert into users (id, email, password_hash) values (${user}, ${`dt-${user}@test.com`}, 'x')`;
    for (const id of [lib, otherLib]) await client`insert into libraries (id, owner_user_id, name) values (${id}, ${user}, 'Train')`;
    for (const rg of [rgLabel, rgOther]) await client`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Train')`;

    const r = rng(11);
    for (let i = 0; i < OWNER_ALBUMS; i++) await album(lib, i, 'owner', r);
    for (let i = 0; i < AUTO_ALBUMS; i++) {
      const a = await album(lib, OWNER_ALBUMS + i, 'auto', r);
      if (i === 0) {
        // the owner rejected a far candidate of an automatic match: a negative of weight 1
        rejectedAuto = a.id; rejectedRelease = a.releases[2]!;
        await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind)
                     values (${lib}, ${a.id}, ${rejectedRelease}, 0.5, 'rejected', 'user', 'unknown')`;
      }
      if (i === 1) {
        // the same release twice, and a linked app's suggestion and an excluded candidate that are never read
        dupAlbum = a.id; dupRelease = a.releases[1]!;
        await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source) values (${a.id}, ${dupRelease}, 0.2500, '{"album":0.3}'::jsonb, 'acoustid')`;
        mcRelease = randomUUID(); excludedRelease = randomUUID();
        for (const x of [mcRelease, excludedRelease]) {
          await client`insert into releases (id, release_group_id, mbid, title) values (${x}, ${rgOther}, ${randomUUID()}, 'Muu')`;
        }
        await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source) values (${a.id}, ${mcRelease}, 0.0001, '{}'::jsonb, 'mc:link')`;
        await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, excluded) values (${a.id}, ${excludedRelease}, 0.0001, '{}'::jsonb, 'mb_search', true)`;
      }
    }
    // an album whose matched release is an excluded candidate: not used
    excludedLabelAlbum = (await album(lib, 999, 'auto', r, { excludedLabel: true })).id;
    // another library's albums are not this library's data
    for (let i = 0; i < 5; i++) await album(otherLib, 2000 + i, 'owner', r);
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('reads the dataset: live matches among their scorable candidates, each release once, owner rejections', async () => {
    const albums = await loadTrainingAlbums(client, lib);
    expect(albums).toHaveLength(OWNER_ALBUMS + AUTO_ALBUMS);
    expect(albums.find((a) => a.albumId === excludedLabelAlbum)).toBeUndefined();
    expect(albums.filter((a) => a.label?.owner).length).toBe(OWNER_ALBUMS);
    for (const a of albums) expect(a.label!.releaseId).toBe(labelOf.get(a.albumId));
    const dup = albums.find((a) => a.albumId === dupAlbum)!;
    expect(dup.candidates.map((c) => c.releaseId).sort()).toEqual([...new Set(dup.candidates.map((c) => c.releaseId))].sort());
    expect(dup.candidates).toHaveLength(3);
    expect(dup.candidates.some((c) => c.releaseId === mcRelease || c.releaseId === excludedRelease)).toBe(false);
    expect(dup.candidates.find((c) => c.releaseId === dupRelease)!.distance).toBeLessThanOrEqual(0.25);
    expect(albums.find((a) => a.albumId === rejectedAuto)!.rejected).toEqual([rejectedRelease]);
    // owner albums are measured by their tracklist groups; automatic ones need none
    for (const a of albums) expect(a.groups === null).toBe(!a.label!.owner);
    const owner = albums.find((a) => a.label!.owner)!;
    expect(owner.groups!.flatMap((g) => g.members.map((m) => m.releaseId)).sort()).toEqual(owner.candidates.map((c) => c.releaseId).sort());
    expect(owner.candidates.filter((c) => c.provider === 'discogs')).toHaveLength(1);
    expect(owner.candidates.every((c) => c.breakdown !== null && typeof c.breakdown['album'] === 'number')).toBe(true);
  });

  it('refuses while the module is off and stores nothing', async () => {
    await setAutotaggerEnabled(client, false);
    const s = await deciderTrainJob(ctx, { libraryId: lib }, { minOwnerAlbums: MIN });
    expect(s).toMatchObject({ state: 'refused', reason: 'module_off' });
    expect(await activeModel(client, lib)).toBeNull();
    expect(await client`select 1 from job_runs where type = 'decider.train'`).toHaveLength(0);
  });

  it('trains and stores the active model; the p99 band decides, and decides right', async () => {
    await setAutotaggerEnabled(client, true);
    const s = await deciderTrainJob(ctx, { libraryId: lib }, { minOwnerAlbums: MIN });
    if (s.state !== 'stored') throw new Error(`not stored: ${JSON.stringify(s)}`);
    expect(s.counts).toEqual({ albums: OWNER_ALBUMS + AUTO_ALBUMS, rows: 3 * (OWNER_ALBUMS + AUTO_ALBUMS), owner: OWNER_ALBUMS, auto: AUTO_ALBUMS, rejections: 1 });
    const p99 = s.metrics.bands.find((b) => b.band === 'p99')!;
    expect(p99.decided).toBeGreaterThan(OWNER_ALBUMS / 2);
    expect(p99).toMatchObject({ wrongRelease: 0, wrongAlbum: 0, errorRate: 0 });
    expect(s.metrics).toMatchObject({ albums: OWNER_ALBUMS, groupedAlbums: OWNER_ALBUMS, topPickRight: { right: OWNER_ALBUMS } });

    const active = await activeModel<LocalModel, LocalTrainMetrics>(client, lib);
    expect(active).toMatchObject({ id: s.modelId, version: s.version, dataHash: s.dataHash, decider: 'local', active: true, counts: s.counts });
    expect(active!.metrics).toEqual(s.metrics);
    // the stored model, read back, is the model the version names, and it decides
    expect(modelVersion(active!.model)).toBe(s.version);
    const albums = await loadTrainingAlbums(client, lib);
    const one = albums.find((a) => a.label!.owner)!;
    expect(calibratedProbability(active!.model, candidateFeatures(one.label!.releaseId, one.candidates))).toBeGreaterThanOrEqual(0.99);
    const [run] = await client`select state, progress from job_runs where type = 'decider.train' and library_id = ${lib}`;
    expect(run).toMatchObject({ state: 'completed', progress: { message: s.version } });
    expect(await activeModel(client, otherLib)).toBeNull();
  });

  it('deterministic: the same data trains the same version; the new model is the one active', async () => {
    const before = await activeModel(client, lib);
    const s = await deciderTrainJob(ctx, { libraryId: lib }, { minOwnerAlbums: MIN });
    if (s.state !== 'stored') throw new Error('not stored');
    expect(s.version).toBe(before!.version);
    expect(s.dataHash).toBe(before!.dataHash);
    const models = await listModels(client, lib, 10);
    expect(models.map((m) => [m.id, m.active])).toEqual([[s.modelId, true], [before!.id, false]]);
    expect(await client`select count(*)::int as n from decider_models where library_id = ${lib} and active`).toEqual([{ n: 1 }]);
  });

  it('refuses too few owner albums with its reason, and keeps the model it had', async () => {
    const before = await activeModel(client, lib);
    const s = await deciderTrainJob(ctx, { libraryId: lib }, { minOwnerAlbums: 10_000 });
    expect(s).toMatchObject({ state: 'refused', reason: 'too_few_owner_albums' });
    expect(s.state === 'refused' && s.message).toMatch(/150 albums the owner decided; training needs 10000/);
    expect((await activeModel(client, lib))!.id).toBe(before!.id);
    const [run] = await client`select state, error from job_runs where type = 'decider.train' and library_id = ${lib} order by started_at desc limit 1`;
    expect(run).toMatchObject({ state: 'failed', error: expect.stringMatching(/training needs 10000/) });
    // the real minimum: this library is under it
    expect(await deciderTrainJob(ctx, { libraryId: lib })).toMatchObject({ state: 'refused', reason: 'too_few_owner_albums' });
  });

  it('refuses a library that is not there', async () => {
    expect(await deciderTrainJob(ctx, { libraryId: randomUUID() })).toMatchObject({ state: 'refused', reason: 'no_library' });
  });

  describe('the command line', () => {
    const io = () => ({ stdout: out(), stderr: out(), env: { DATABASE_URL: url } });

    it('refuses a wrong --confirm-database, a missing library and bad usage (exit 2), before anything is read', async () => {
      const a = io();
      expect(await runCli(['train', '--library', lib, '--confirm-database', 'tagave', '--dry-run'], a)).toBe(2);
      expect(a.stderr.text).toMatch(/--confirm-database does not name/);
      const b = io();
      expect(await runCli(['train', '--library', randomUUID(), '--confirm-database', name, '--dry-run'], b)).toBe(2);
      expect(b.stderr.text).toMatch(/no such library/);
      const c = io();
      expect(await runCli(['train', '--library', lib], c)).toBe(2);
      expect(c.stderr.text).toMatch(/--confirm-database is required/);
      const d = io();
      expect(await runCli(['train', '--library', lib, '--confirm-database', name], { ...d, env: {} })).toBe(2);
      expect(d.stderr.text).toMatch(/DATABASE_URL is required/);
    });

    it('a dry run trains on the real minimum (too few here: exit 1) and stores nothing', async () => {
      const before = await client`select count(*)::int as n from decider_models`;
      const a = io();
      expect(await runCli(['train', '--library', lib, '--confirm-database', name, '--dry-run'], a)).toBe(1);
      expect(a.stderr.text).toMatch(/not trained \(too_few_owner_albums\)/);
      expect(await client`select count(*)::int as n from decider_models`).toEqual(before);
    });

    it('stores only with the module on, or --copy on a database not named as the live one', async () => {
      // more owner albums would be slow here; the command trains on the real minimum,
      // so a library under it is refused after the store checks pass
      await setAutotaggerEnabled(client, false);
      try {
        const a = io();
        expect(await runCli(['train', '--library', lib, '--confirm-database', name], a)).toBe(2);
        expect(a.stderr.text).toMatch(/autotagger is off here; pass --dry-run, or --copy/);
        const b = io();
        expect(await runCli(['train', '--library', lib, '--confirm-database', name, '--copy'], b)).toBe(1);
        expect(b.stderr.text).toMatch(/too_few_owner_albums/);
      } finally {
        await setAutotaggerEnabled(client, true);
      }
    });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.train command line on a trainable library (scratch db)', () => {
  // the command trains on the real minimum of owner albums, so this library has it
  let admin: postgres.Sql;
  let client: any;
  let url = '';
  const name = `tagave_dtcli_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const user = randomUUID();
  const lib = randomUUID();

  beforeAll(async () => {
    admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    url = u.toString();
    await runMigrations(url, { log: () => undefined });
    client = (await makeDb(url)).client;
    await syncInstalledModules(client, ledgerEntries());
    await client`insert into users (id, email, password_hash) values (${user}, ${`dc-${user}@test.com`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name) values (${lib}, ${user}, 'Cli')`;
    const rg = randomUUID();
    await client`insert into release_groups (id, mbid, title) values (${rg}, ${randomUUID()}, 'Cli')`;
    // 220 owner albums, two candidates each, set-based: albums, releases, candidates, matches
    const r = rng(5);
    const n = 220;
    const albums = Array.from({ length: n }, () => randomUUID());
    const near = albums.map(() => randomUUID());
    const far = albums.map(() => randomUUID());
    await client`insert into local_albums (id, library_id, cluster_key, state)
                 select a, ${lib}, 'k-' || a::text, 'matched' from unnest(${albums}::uuid[]) as a`;
    await client`insert into releases (id, release_group_id, mbid, title)
                 select x, ${rg}, x::text, 'Cli' from unnest(${[...near, ...far]}::uuid[]) as x`;
    const dist = (isNear: boolean) => (isNear ? r() * 0.08 : 0.3 + r() * 0.4).toFixed(4);
    await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source)
                 select a, x, d::numeric, '{}'::jsonb, 'mb_search'
                   from unnest(${[...albums, ...albums]}::uuid[], ${[...near, ...far]}::uuid[], ${[...near.map(() => dist(true)), ...far.map(() => dist(false))]}::text[]) as t(a, x, d)`;
    await client`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind)
                 select ${lib}, a, x, 0.01, 'confirmed', 'user', 'user' from unnest(${albums}::uuid[], ${near}::uuid[]) as t(a, x)`;
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  const out = () => { let s = ''; return { write: (x: string) => { s += x; }, get text() { return s; } }; };

  it('a dry run prints the counts and the table, writes the json and stores nothing', async () => {
    const io = { stdout: out(), stderr: out(), env: { DATABASE_URL: url } };
    const json = path.join(tmpdir(), `local-train-${randomUUID()}.json`);
    expect(await runCli(['train', '--library', lib, '--confirm-database', name, '--dry-run', '--json', json], io)).toBe(0);
    expect(io.stdout.text).toMatch(/^albums 220 {2}rows 440 {2}owner 220 {2}auto 0 {2}rejections 0\n/);
    expect(io.stdout.text).toMatch(/not stored/);
    expect(io.stdout.text).toMatch(/\np99 +\d+/);
    expect(io.stdout.text).toMatch(/top pick right 220\/220/);
    const written = JSON.parse(await readFile(json, 'utf8'));
    await rm(json, { force: true });
    expect(written).toMatchObject({ counts: { albums: 220, owner: 220 }, stored: null, version: expect.stringMatching(/^local@[0-9a-f]{12}$/) });
    expect(await client`select 1 from decider_models`).toHaveLength(0);
  });

  it('--copy stores the active model on a copy with the module off; the same version as the dry run', async () => {
    const dry = { stdout: out(), stderr: out(), env: { DATABASE_URL: url } };
    await runCli(['train', '--library', lib, '--confirm-database', name, '--dry-run'], dry);
    const io = { stdout: out(), stderr: out(), env: { DATABASE_URL: url } };
    expect(await runCli(['train', '--library', lib, '--confirm-database', name, '--copy'], io)).toBe(0);
    const active = await activeModel(client, lib);
    expect(io.stdout.text).toContain(`stored as ${active!.id} (active)`);
    const version = /model (local@[0-9a-f]{12})/.exec(dry.stdout.text)![1];
    expect(active!.version).toBe(version);
  });
});

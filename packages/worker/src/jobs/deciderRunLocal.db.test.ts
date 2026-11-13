/**
 * decider.run with the local decider against a real database: the run
 * scores every tracklist group with the library's stored model, records its
 * picks, and needs no key, payload preview, price or cap (nothing leaves the
 * machine, nothing is billed). A run whose model is gone pauses (no_model).
 *
 * On a scratch database: the run needs the module switched on, and the
 * shared test database's switch belongs to every suite running at once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import pino from 'pino';
import { makeDb, runMigrations, setAutotaggerEnabled, storeModel, syncInstalledModules } from '@tagave/db';
import {
  LOCAL_FEATURE_NAMES, buildAlbumEvidence, buildCandidateEvidence, featuresSchemaHash, jevSpecHash, modelVersion, type LocalModel,
} from '@tagave/core';
import { ledgerEntries } from '@tagave/core/facets';
import type { WorkerContext } from '../lib/context.js';
import { upsertAlbumEvidence } from '../lib/evidenceStore.js';
import { deciderRunJob } from './deciderRun.js';

/** Sure of the closest candidate alone: the score falls steeply with the distance. */
function distanceModel(): LocalModel {
  const n = LOCAL_FEATURE_NAMES.length;
  return {
    version: 1,
    featuresSchemaHash: featuresSchemaHash(),
    logistic: {
      intercept: 6, coefficients: LOCAL_FEATURE_NAMES.map((nm) => (nm === 'distance' ? -40 : 0)),
      means: new Array(n).fill(0), stds: new Array(n).fill(1), featureNames: LOCAL_FEATURE_NAMES, iterations: 1, converged: true,
    },
    isotonic: { blocks: [{ lo: 0, hi: 0, p: 0.01, weight: 1 }, { lo: 1, hi: 1, p: 0.999, weight: 1 }] },
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider.run, local decider (scratch db)', () => {
  let admin: postgres.Sql;
  let client: any;
  let ctx: WorkerContext;
  const name = `tagave_drlocal_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const owner = randomUUID();
  const lib = randomUUID();
  const rg = randomUUID();
  const send = vi.fn(async (..._args: unknown[]): Promise<string | null> => 'job');
  const model = distanceModel();
  const version = modelVersion(model);
  let sure = '', sureRelease = '', unsure = '';

  async function makeAlbum(title: string, candidates: Array<{ distance: number; titles?: string[] }>): Promise<{ id: string; releases: string[] }> {
    const tracks = ['Ilta', 'Aamu', 'Yö'];
    const id = randomUUID();
    await client`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess, artist_guess, state, identify_reason, track_count, title_source, last_identify_at)
                 values (${id}, ${lib}, ${'k-' + id}, ${['x/' + id]}, ${title}, 'Kuunvalo', 'needs_review', 'close call', ${tracks.length}, 'tag', now())`;
    await upsertAlbumEvidence(client, id, buildAlbumEvidence({
      artist: 'Kuunvalo', title, titleSource: 'tag', year: 2001, yearSource: 'tag', discsKnown: false, discCount: null,
      tracks: tracks.map((t, i) => ({ title: t, titleSource: 'tag' as const, duration: 200 + i * 10 })),
    }));
    const releases: string[] = [];
    for (const c of candidates) {
      const rid = randomUUID();
      const titles = c.titles ?? tracks;
      releases.push(rid);
      await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                   values (${rid}, ${rg}, ${randomUUID()}, ${title}, 'Official', ${titles.length}, 'musicbrainz')`;
      const shared = Math.min(tracks.length, titles.length);
      const ev = buildCandidateEvidence(
        { source: 'musicbrainz', title, artists: ['Kuunvalo'], status: 'Official', tracks: titles.map((t, i) => ({ title: t, duration: 200 + i * 10 })) },
        {
          alignment: tracks.map((_, i) => ({ localIndex: i, canonicalIndex: i < shared ? i : null, distance: 0.01, title: { local: '' }, duration: { local: 0 } })),
          missingRemote: titles.map((_, i) => i).filter((i) => i >= shared),
        },
        tracks.length);
      await client`insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence)
                   values (${id}, ${rid}, ${c.distance}, '{"album": 0.01}'::jsonb, 'mb_search', ${JSON.stringify(ev)}::text::jsonb)`;
    }
    return { id, releases };
  }

  async function newRun(modelRequested: string): Promise<string> {
    const [r] = await client`insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, started_by_user_id)
                             values (${lib}, 'local', ${jevSpecHash()}, ${modelRequested}, 'needs_review', ${owner}) returning id`;
    return r.id as string;
  }

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
    await client`create schema if not exists pgboss`;
    await client`create table if not exists pgboss.job (name text not null, singleton_key text, state text not null)`;
    await client`insert into users (id, email, password_hash) values (${owner}, ${`drl-${owner}@test.com`}, 'x')`;
    await client`insert into libraries (id, owner_user_id, name, settings) values (${lib}, ${owner}, 'LocalRun', '{}'::jsonb)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'Kuunvalo', ${JSON.stringify(['Kuunvalo'])}::text::jsonb)`;
    // one album with a clear winner, one whose two tracklists are equally far
    const a = await makeAlbum('Selvä', [{ distance: 0.02 }, { distance: 0.6, titles: ['Yksi', 'Kaksi'] }]);
    sure = a.id; sureRelease = a.releases[0]!;
    unsure = (await makeAlbum('Epävarma', [{ distance: 0.4 }, { distance: 0.4, titles: ['Yksi', 'Kaksi'] }])).id;
    await storeModel(client, {
      libraryId: lib, decider: 'local', version, featuresSchemaHash: model.featuresSchemaHash, model,
      dataHash: 'a'.repeat(64), counts: { albums: 0, rows: 0, owner: 0, auto: 0, rejections: 0 }, metrics: {},
    });
    await setAutotaggerEnabled(client, true);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('decides with the stored model: no key, no payload seen, no price, no cap; nothing billed', async () => {
    const run = await newRun(version);
    const summary = await deciderRunJob(ctx, { runId: run });
    expect(summary).toMatchObject({ state: 'done', billed: 0 });
    const [r] = await client`select state, decider_version from decider_runs where id = ${run}`;
    expect(r).toEqual({ state: 'done', decider_version: version });
    const [d] = await client`select outcome, band, release_id from decider_decisions where run_id = ${run} and local_album_id = ${sure}`;
    expect(d).toEqual({ outcome: 'pick', band: 'p99', release_id: sureRelease });
    const [u] = await client`select outcome from decider_decisions where run_id = ${run} and local_album_id = ${unsure}`;
    expect(u.outcome).toBe('none');
    const calls = await client`select decider_id, decider_version, cost::text as cost, input_tokens from decider_calls where run_id = ${run}`;
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toEqual({ decider_id: 'local', decider_version: version, cost: '0.000000', input_tokens: 0 });
  });

  it('a second run over the same evidence reuses the stored answers', async () => {
    const run = await newRun(version);
    const summary = await deciderRunJob(ctx, { runId: run });
    expect(summary).toMatchObject({ state: 'done', reused: 2, billed: 0 });
  });

  it('a run whose model is not stored pauses: no_model', async () => {
    const run = await newRun('local@000000000000');
    expect(await deciderRunJob(ctx, { runId: run })).toMatchObject({ state: 'paused', pauseReason: 'no_model' });
  });

  it('the module off pauses a local run too', async () => {
    await setAutotaggerEnabled(client, false);
    try {
      const run = await newRun(version);
      expect(await deciderRunJob(ctx, { runId: run })).toMatchObject({ state: 'paused', pauseReason: 'module_off' });
    } finally {
      await setAutotaggerEnabled(client, true);
    }
  });
});

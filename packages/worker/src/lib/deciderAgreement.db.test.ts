/**
 * Agreement between the decider and the owner, against a real database. It
 * only informs: nothing reads it to accept anything.
 *
 *   backtest  a backtest run's decisions against what the owner decided
 *             before: a live match the owner made, or the album kept as is
 *   queue     the owner's review-queue decisions made after the latest
 *             decision of a needs_review run on the album
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { backtestAgreement, latestBacktestRunId, makeDb, queueAgreement } from '@tagave/db';

describe.skipIf(!process.env.TEST_DATABASE_URL)('decider agreement (shared db: its own libraries only)', () => {
  let client: any;
  const userId = randomUUID();
  const lib = randomUUID();
  const queueLib = randomUUID();
  const rg = randomUUID();
  const releases: string[] = Array.from({ length: 8 }, () => randomUUID());
  const [r1, r2, r3, other, q1, q2, q3, q4] = releases as [string, string, string, string, string, string, string, string];

  const album = async (libraryId: string, state: string, updatedAt = '2026-10-01T00:00:00Z'): Promise<string> => {
    const id = randomUUID();
    await client`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, updated_at)
                 values (${id}, ${libraryId}, ${`ck-${id}`}, 'A', 'B', ${state}, ${updatedAt}::timestamptz)`;
    return id;
  };
  const match = (libraryId: string, albumId: string, releaseId: string, o: { kind?: string; status?: string; createdAt?: string; reason?: string } = {}) => client`
    insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by, decided_kind, reason, created_at, decided_at)
    values (${libraryId}, ${albumId}, ${releaseId}, 0.1, ${o.status ?? 'confirmed'}, ${o.kind === 'user' || !o.kind ? 'user' : 'system'},
            ${o.kind ?? 'user'}, ${o.reason ?? 'accepted in review queue'},
            ${o.createdAt ?? '2026-10-01T00:00:00Z'}::timestamptz, ${o.createdAt ?? '2026-10-01T00:00:00Z'}::timestamptz)`;
  const run = async (libraryId: string, population: string, state = 'done', finishedAt = '2026-10-10T00:00:00Z'): Promise<string> => {
    const [row] = await client`
      insert into decider_runs (library_id, decider_id, spec_hash, model_requested, population, state, finished_at)
      values (${libraryId}, 'jev', 's1', 'jev-latest', ${population}, ${state}, ${finishedAt}::timestamptz) returning id::text as id`;
    return row.id;
  };
  const decide = (runId: string, albumId: string, d: { outcome: string; band?: string | null; group?: string[]; createdAt?: string }) => client`
    insert into decider_decisions (run_id, local_album_id, outcome, band, group_release_ids, created_at)
    values (${runId}, ${albumId}, ${d.outcome}, ${d.band ?? null}, ${d.group ?? []}::uuid[], ${d.createdAt ?? '2026-10-05T00:00:00Z'}::timestamptz)`;

  beforeAll(async () => {
    client = (await makeDb(process.env.TEST_DATABASE_URL!)).client;
    await client`insert into users (id, email, password_hash) values (${userId}, ${`agree-${userId}@test.com`}, 'x')`;
    for (const id of [lib, queueLib]) await client`insert into libraries (id, owner_user_id, name, settings) values (${id}, ${userId}, 'Agree', '{}'::jsonb)`;
    await client`insert into release_groups (id, mbid, title, artist_credit) values (${rg}, ${randomUUID()}, 'G', ${JSON.stringify(['B'])}::text::jsonb)`;
    for (const id of releases) {
      await client`insert into releases (id, release_group_id, mbid, title, status, track_count, source_of_truth)
                   values (${id}, ${rg}, ${randomUUID()}, 'R', 'Official', 3, 'musicbrainz')`;
    }
  });

  afterAll(async () => {
    await client`delete from libraries where id = any(${[lib, queueLib]}::uuid[])`;
    await client`delete from releases where id = any(${releases}::uuid[])`;
    await client`delete from release_groups where id = ${rg}`;
    await client`delete from users where id = ${userId}`;
    await client.end({ timeout: 5 });
  });

  it('a backtest run against the owner\'s past decisions, per band', async () => {
    const a1 = await album(lib, 'matched');
    const a2 = await album(lib, 'matched');
    const a3 = await album(lib, 'matched');
    const kept = await album(lib, 'as_is');
    const keptNone = await album(lib, 'as_is');
    const bySystem = await album(lib, 'matched');
    await match(lib, a1, r1);
    await match(lib, a2, r2);
    await match(lib, a3, r3);
    // the matcher's own match is not the owner's decision
    await match(lib, bySystem, r1, { kind: 'system', status: 'auto', reason: 'auto-accept: strong' });
    const backtest = await run(lib, 'backtest');
    await decide(backtest, a1, { outcome: 'pick', band: 'p99', group: [r1, other] });
    await decide(backtest, a2, { outcome: 'pick', band: 'p95', group: [other] });
    await decide(backtest, a3, { outcome: 'none' });
    await decide(backtest, kept, { outcome: 'pick', band: 'p97', group: [other] });
    await decide(backtest, keptNone, { outcome: 'none' });
    await decide(backtest, bySystem, { outcome: 'pick', band: 'p99', group: [r1] });
    expect(await backtestAgreement(client, backtest)).toEqual([
      { band: 'p99', decided: 1, agree: 1, disagree: 0, noDecision: 0 },
      { band: 'p97', decided: 1, agree: 0, disagree: 1, noDecision: 0 },
      { band: 'p95', decided: 1, agree: 0, disagree: 1, noDecision: 0 },
      // none on a matched album: no decision; none on an album kept as is: agrees
      { band: 'none', decided: 2, agree: 1, disagree: 0, noDecision: 1 },
    ]);
    expect(await backtestAgreement(client, randomUUID())).toEqual([]);
  });

  it('the latest done backtest run of the library', async () => {
    const before = await latestBacktestRunId(client, lib);
    expect(before).not.toBeNull();
    await run(lib, 'backtest', 'running', '2026-12-01T00:00:00Z');
    await run(lib, 'needs_review', 'done', '2026-12-01T00:00:00Z');
    expect(await latestBacktestRunId(client, lib)).toBe(before);
    const newer = await run(lib, 'backtest', 'done', '2026-11-01T00:00:00Z');
    expect(await latestBacktestRunId(client, lib)).toBe(newer);
    expect(await latestBacktestRunId(client, queueLib)).toBeNull();
  });

  it('review-queue decisions made after the latest needs_review decision', async () => {
    const after = await album(queueLib, 'matched');
    const before = await album(queueLib, 'matched');
    const byModel = await album(queueLib, 'matched');
    const keptLater = await album(queueLib, 'as_is', '2026-10-06T00:00:00Z');
    const backtestOnly = await album(queueLib, 'matched');
    const changed = await album(queueLib, 'matched');
    const older = await run(queueLib, 'needs_review', 'done', '2026-10-02T00:00:00Z');
    const review = await run(queueLib, 'needs_review');
    const backtest = await run(queueLib, 'backtest');
    // the newer decision on an album counts, not the older one
    await decide(older, after, { outcome: 'none', createdAt: '2026-10-01T12:00:00Z' });
    await decide(review, after, { outcome: 'pick', band: 'p99', group: [q1, other] });
    await match(queueLib, after, q1, { createdAt: '2026-10-06T00:00:00Z' });
    // the owner decided before the decision: not a queue decision made after it
    await decide(review, before, { outcome: 'pick', band: 'p99', group: [other] });
    await match(queueLib, before, q2, { createdAt: '2026-10-04T00:00:00Z' });
    // accepted by a model, not by the owner
    await decide(review, byModel, { outcome: 'pick', band: 'p97', group: [q3] });
    await match(queueLib, byModel, q3, { kind: 'model', status: 'auto', reason: 'decider', createdAt: '2026-10-06T00:00:00Z' });
    // kept as is after a none
    await decide(review, keptLater, { outcome: 'none' });
    // a backtest run is not the review queue
    await decide(backtest, backtestOnly, { outcome: 'pick', band: 'p90', group: [q4] });
    await match(queueLib, backtestOnly, q4, { createdAt: '2026-10-06T00:00:00Z' });
    // the owner picked another edition than the group
    await decide(review, changed, { outcome: 'pick', band: 'p95', group: [other] });
    await match(queueLib, changed, q4, { createdAt: '2026-10-07T00:00:00Z' });
    expect(await queueAgreement(client, queueLib)).toEqual([
      { band: 'p99', decided: 1, agree: 1, disagree: 0, noDecision: 0 },
      { band: 'p95', decided: 1, agree: 0, disagree: 1, noDecision: 0 },
      { band: 'none', decided: 1, agree: 1, disagree: 0, noDecision: 0 },
    ]);
    expect(await queueAgreement(client, randomUUID())).toEqual([]);
  });
});

/**
 * Worker heartbeat checks, on a scratch database next to TEST_DATABASE_URL:
 * the checks read every heartbeat, so the suite needs an empty table, and
 * emptying the shared one would wipe other suites' rows. Heartbeats live in
 * worker_heartbeats (0027), which needs no library: on a fresh install the
 * workers run before the owner account (and its library) exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '@tagave/db';
import { checkWorkerHeartbeat, checkWorkerVersions, workerCoverageCheck } from './checks.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('worker heartbeat checks (integration)', () => {
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  let name: string;
  let dbUrl: string;
  const ids = [`test-worker-${randomUUID()}`, `test-worker-${randomUUID()}`];

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    name = `tagave_doc_hb_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.unsafe(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await runMigrations(dbUrl, { log: () => undefined });
    sql = postgres(dbUrl, { max: 1, onnotice: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('fails with no heartbeat, then passes once a worker has checked in', async () => {
    expect((await checkWorkerHeartbeat(dbUrl, 1)).status).toBe('fail');
    await sql`insert into worker_heartbeats (worker_id, info) values (${ids[0]!}, ${sql.json({ workerId: ids[0]!, sha: 'abc1234' })})`;
    // an older build's heartbeat carries no queue list: it served every queue
    expect(await checkWorkerHeartbeat(dbUrl, 1)).toMatchObject({ status: 'pass', detail: '1 worker running, handling all work' });
    // the count configured does not matter, only the work covered
    expect(await checkWorkerHeartbeat(dbUrl, 2)).toMatchObject({ status: 'pass', detail: '1 worker running, handling all work' });
    await sql`update worker_heartbeats set info = ${sql.json({ workerId: ids[0]!, queues: ['identify.album', 'identify.acoustid', 'identify.sweep'] })} where worker_id = ${ids[0]!}`;
    const split = await checkWorkerHeartbeat(dbUrl, 1);
    expect(split.status).toBe('warn');
    expect(split.detail).toMatch(/^1 worker running, but none handles reading music folders, /);
  });

  it('ignores a heartbeat older than two minutes', async () => {
    await sql`insert into worker_heartbeats (worker_id, seen_at, info)
              values (${ids[1]!}, now() - interval '5 minutes', ${sql.json({ workerId: ids[1]!, sha: 'old0000' })})`;
    const check = await checkWorkerHeartbeat(dbUrl, 2);
    expect(check.detail).toMatch(/^1 worker running/);
    const versions = await checkWorkerVersions(dbUrl);
    expect(versions.detail).not.toContain('old0000');
    // plain words on the status page, not process internals
    expect(versions.detail).not.toMatch(/this process|\(\d+\)/);
  });
});

describe('workerCoverageCheck', () => {
  it('passes when one worker serves every queue', () => {
    expect(workerCoverageCheck(1, [['*']])).toMatchObject({ status: 'pass', detail: '1 worker running, handling all work' });
  });
  it('passes for a split install that covers every queue between its workers', async () => {
    const { GATED_QUEUES } = await import('@tagave/core');
    const half = Math.floor(GATED_QUEUES.length / 2);
    expect(workerCoverageCheck(2, [GATED_QUEUES.slice(0, half), GATED_QUEUES.slice(half)]).status).toBe('pass');
  });
  it('names the work nobody takes when the files worker is missing', () => {
    const check = workerCoverageCheck(1, [['identify.album', 'identify.acoustid', 'identify.sweep', 'acoustid.lookup', 'artists.resolve', 'artists.enrich']]);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('reading music folders');
    expect(check.detail).toMatch(/^1 worker running, but none handles reading music folders, /);
    expect(check.detail).not.toMatch(/expected|\./);
  });
});

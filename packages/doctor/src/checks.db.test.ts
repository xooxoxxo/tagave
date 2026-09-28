/**
 * Worker heartbeat checks against TEST_DATABASE_URL. Heartbeats live in
 * worker_heartbeats (0027), which needs no library: on a fresh install the
 * workers run before the owner account (and its library) exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { checkWorkerHeartbeat, checkWorkerVersions } from './checks.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('worker heartbeat checks (integration)', () => {
  let sql: ReturnType<typeof postgres>;
  const ids = [`test-worker-${randomUUID()}`, `test-worker-${randomUUID()}`];

  beforeAll(async () => {
    sql = postgres(url!, { max: 1 });
    await sql`delete from worker_heartbeats`;
  });

  afterAll(async () => {
    await sql`delete from worker_heartbeats where worker_id in ${sql(ids)}`;
    await sql.end({ timeout: 2 });
  });

  it('fails with no heartbeat, then passes once a worker has checked in', async () => {
    expect((await checkWorkerHeartbeat(url!, 1)).status).toBe('fail');
    await sql`insert into worker_heartbeats (worker_id, info) values (${ids[0]!}, ${sql.json({ workerId: ids[0]!, sha: 'abc1234' })})`;
    expect((await checkWorkerHeartbeat(url!, 1)).status).toBe('pass');
    expect((await checkWorkerHeartbeat(url!, 2)).status).toBe('warn');
  });

  it('ignores a heartbeat older than two minutes', async () => {
    await sql`insert into worker_heartbeats (worker_id, seen_at, info)
              values (${ids[1]!}, now() - interval '5 minutes', ${sql.json({ workerId: ids[1]!, sha: 'old0000' })})`;
    const check = await checkWorkerHeartbeat(url!, 2);
    expect(check.status).toBe('warn');
    const versions = await checkWorkerVersions(url!);
    expect(versions.detail).not.toContain('old0000');
  });
});

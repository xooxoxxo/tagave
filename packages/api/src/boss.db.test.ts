/**
 * The API's pg-boss must survive its database connections dropping (audit
 * 2026-10-10, offender 5): Postgres restarting killed the API process with
 * "Unhandled 'error' event ... Connection terminated unexpectedly".
 *
 * Reproduced by terminating the boss's backends with pg_terminate_backend,
 * which is what a Postgres restart does to every client. A unique
 * application_name scopes the kill to the boss under test. The bosses run in
 * a scratch database of their own: other suites stub pgboss.job in the
 * shared test database, where a real pg-boss cannot install its schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));

function withAppName(base: string, name: string): string {
  const u = new URL(base);
  u.searchParams.set('application_name', name);
  return u.toString();
}

describe.skipIf(!url)('pg-boss connection drop (db)', () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => undefined }) : (null as never);
  const scratchDb = `boss_drop_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let scratchUrl = '';

  beforeAll(async () => {
    await admin.unsafe(`create database ${scratchDb}`);
    const u = new URL(url!);
    u.pathname = `/${scratchDb}`;
    scratchUrl = u.toString();
  });

  afterAll(async () => {
    // drop the scratch database, closing whatever connections are left in it
    await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${scratchDb}' and pid <> pg_backend_pid()`);
    await admin.unsafe(`drop database if exists ${scratchDb}`);
    await admin?.end({ timeout: 5 });
  });

  async function killBackends(appName: string): Promise<number> {
    const rows = await admin`
      select pg_terminate_backend(pid) as killed from pg_stat_activity
       where application_name = ${appName} and pid <> pg_backend_pid()`;
    return rows.length;
  }

  it('without an error listener the process dies (the bug)', () => {
    const appName = `boss-bare-${randomUUID().slice(0, 8)}`;
    // A bare PgBoss, as api/src/boss.ts was: start, idle, have its
    // connections terminated from outside, see whether the process lives.
    const script = `
      import PgBoss from 'pg-boss';
      import postgres from 'postgres';
      const boss = new PgBoss(${JSON.stringify(withAppName(scratchUrl, appName))});
      await boss.start();
      await Promise.all([boss.getQueues(), boss.getQueues(), boss.getQueues()]);
      const admin = postgres(${JSON.stringify(url)}, { max: 1 });
      await admin.unsafe("select pg_terminate_backend(pid) from pg_stat_activity where application_name = '${appName}' and pid <> pg_backend_pid()");
      await admin.end();
      await new Promise((r) => setTimeout(r, 1500));
      console.log('SURVIVED');
      await boss.stop({ graceful: false, wait: false }).catch(() => {});
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(here, '..'), encoding: 'utf8', timeout: 30_000,
    });
    expect(res.stdout).not.toContain('SURVIVED');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Unhandled 'error' event");
    expect(res.stderr).toMatch(/terminating connection/);
  }, 40_000);

  it('getBoss() logs the drop, stays up and keeps working', async () => {
    const appName = `boss-api-${randomUUID().slice(0, 8)}`;
    process.env.DATABASE_URL = withAppName(scratchUrl, appName);
    const { getBoss, setBossLogger } = await import('./boss.js');
    const logged: unknown[] = [];
    setBossLogger({ error: (obj) => logged.push(obj) });
    const boss = await getBoss();
    expect(boss.listenerCount('error')).toBeGreaterThan(0);
    await Promise.all([boss.getQueues(), boss.getQueues(), boss.getQueues()]);

    expect(await killBackends(appName)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(logged.length).toBeGreaterThan(0);

    // The pool reconnects on next use: queue work again.
    const queue = `boss-drop-test-${randomUUID().slice(0, 8)}`;
    await boss.createQueue(queue);
    const id = await boss.send(queue, { ok: true });
    expect(id).toBeTruthy();
    await boss.deleteQueue(queue);
    await boss.stop({ graceful: false, wait: true, timeout: 5_000 });
  }, 40_000);
});

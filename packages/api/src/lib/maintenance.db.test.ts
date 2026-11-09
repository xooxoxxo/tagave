import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import Fastify from 'fastify';
import {
  dispatchMaintenanceTask, getMaintenanceTask, reconcileMaintenanceTasks, restartMaintenanceTask,
  saveMaintenanceTask, undispatchedMaintenanceTasks, updateMaintenanceTask, withMaintenanceClaim,
} from '@tagave/db';
import { createScratchDb, migrateAll } from '../testkit/authApp.js';
import { maintenanceSender } from './maintenance.js';
import { initDb } from '../db.js';
import { createMaintenanceRoutes } from '../routes/maintenance.js';
import { artFetchState } from './artFetchState.js';

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('maintenance task delivery', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let db: { url: string; name: string };
  let boss: PgBoss;
  let libraryId: string;
  const queue = 'test.maintenance';

  beforeAll(async () => {
    admin = postgres(adminUrl!, { onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await migrateAll(db.url);
    sql = postgres(db.url, { onnotice: () => undefined });
    const [owner] = await sql<{ id: string }[]>`insert into users (email) values ('test@example.com') returning id`;
    const [library] = await sql<{ id: string }[]>`
      insert into libraries (owner_user_id, name) values (${owner!.id}, 'Scratch') returning id
    `;
    libraryId = library!.id;
    boss = new PgBoss({ connectionString: db.url, supervise: false, schedule: false });
    await boss.start();
    await boss.createQueue(queue);
  }, 60_000);

  afterAll(async () => {
    await boss?.stop();
    await sql?.end();
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`);
    await admin?.end();
  });

  const request = () => ({ libraryId, kind: 'cover' as const, scope: randomUUID(), queue, input: { ask: 'cover' }, stage: 'Waiting' });

  it('saves and dispatches the same active task once across concurrent requests', async () => {
    const req = request();
    const [one, two] = await Promise.all([saveMaintenanceTask(sql, req), saveMaintenanceTask(sql, req)]);
    expect(two.id).toBe(one.id);
    await Promise.all([one, two].map((row) => dispatchMaintenanceTask(sql, maintenanceSender(boss), row.id)));
    expect(await sql`select id, data from pgboss.job where id = ${one.attempt_id}`).toEqual([{
      id: one.attempt_id, data: { ask: 'cover', maintenance: { taskId: one.id, attemptId: one.attempt_id } },
    }]);
  });

  it('queues two tasks at once on a stately queue (files.split, tags.apply, art.fetch run stately)', async () => {
    const stately = 'test.maintenance.stately';
    await boss.createQueue(stately, { policy: 'stately' });
    const one = await saveMaintenanceTask(sql, { ...request(), queue: stately });
    const two = await saveMaintenanceTask(sql, { ...request(), queue: stately });
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), one.id);
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), two.id);
    expect(await undispatchedMaintenanceTasks(sql)).not.toContain(two.id);
    expect((await sql`select id from pgboss.job where name = ${stately}`).map((r) => r.id).sort()).toEqual([one.attempt_id, two.attempt_id].sort());
  });

  it('keeps the intent in the outbox if dispatch fails', async () => {
    const row = await saveMaintenanceTask(sql, request());
    await expect(dispatchMaintenanceTask(sql, async () => { throw new Error('offline'); }, row.id)).rejects.toThrow('offline');
    expect(await undispatchedMaintenanceTasks(sql)).toContain(row.id);
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), row.id);
    expect(await undispatchedMaintenanceTasks(sql)).not.toContain(row.id);
  });

  it('interrupts a lost job and fences a retry while the earlier worker still holds the scope', async () => {
    const row = await saveMaintenanceTask(sql, request());
    await dispatchMaintenanceTask(sql, maintenanceSender(boss), row.id);
    const work = { taskId: row.id, attemptId: row.attempt_id };
    await withMaintenanceClaim(sql, work, async () => {
      await boss.cancel(queue, row.attempt_id);
      await reconcileMaintenanceTasks(sql);
      expect((await getMaintenanceTask(sql, libraryId, row.id))?.state).toBe('interrupted');
      const next = await restartMaintenanceTask(sql, libraryId, row.id, 1);
      expect(next?.attempt).toBe(2);
      expect(await updateMaintenanceTask(sql, work, { state: 'done' })).toBe(false);
      expect(await withMaintenanceClaim(sql, { taskId: row.id, attemptId: next!.attempt_id }, async () => 'started')).toBeUndefined();
    });
    const next = (await getMaintenanceTask(sql, libraryId, row.id))!;
    expect(await withMaintenanceClaim(sql, { taskId: row.id, attemptId: next.attempt_id }, async () => 'started')).toBe('started');
  });

  it('returns the same task and recovery action after a reload', async () => {
    const handle = await initDb(db.url);
    const app = Fastify();
    await app.register(createMaintenanceRoutes);
    try {
      const row = await saveMaintenanceTask(sql, request());
      const cover = await saveMaintenanceTask(sql, { ...request(), queue: 'art.fetch' });
      expect(await artFetchState(cover.scope_key, libraryId)).toMatchObject({ state: 'unavailable', task: { id: cover.id } });
      const base = `/libraries/${libraryId}/maintenance-tasks`;
      const first = await app.inject({ url: `${base}/${row.id}` });
      expect(first.json()).toMatchObject({ id: row.id, state: 'waiting', stage: 'Waiting for the file worker' });
      await sql`insert into worker_heartbeats (worker_id, info) values ('file', ${sql.json({ queues: [queue, 'art.fetch'] })})`;
      await sql`update maintenance_tasks set state = 'interrupted', checkpoint = '{"file": 2}' where id = ${row.id}`;
      const list = await app.inject({ url: base });
      expect(list.json().tasks).toContainEqual(expect.objectContaining({
        id: row.id, state: 'interrupted', workerAvailable: true, actions: ['continue'],
      }));
      await sql`update maintenance_tasks set state = 'interrupted' where id = ${cover.id}`;
      expect(await artFetchState(cover.scope_key, libraryId)).toMatchObject({ state: 'interrupted', task: { actions: ['retry'] } });
      await sql`update maintenance_tasks set state = 'done', stage = 'No cover art found' where id = ${cover.id}`;
      expect(await artFetchState(cover.scope_key, libraryId)).toMatchObject({ state: 'done', task: { stage: 'No cover art found' } });
    } finally {
      await app.close();
      await handle.client.end();
    }
  });
});

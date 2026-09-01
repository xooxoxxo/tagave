import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import { makeDb } from '@liner/db';

export type Db = Awaited<ReturnType<typeof makeDb>>['db'];
export type Sql = Awaited<ReturnType<typeof makeDb>>['client'];

/** Shared per-process context; created once at boot, passed to every job. */
export interface WorkerContext {
  db: Db;
  sql: Sql;
  boss: PgBoss;
  logger: Logger;
}

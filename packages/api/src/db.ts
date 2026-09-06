import { makeDb } from '@liner/db';

/** One connection pool for the whole API process. Route handlers previously
 * called makeDb() per request, each spawning a fresh postgres.js pool that
 * never closed — connection exhaustion after a few dozen requests. */
let instance: Awaited<ReturnType<typeof makeDb>> | undefined;

export async function initDb(databaseUrl: string): Promise<Awaited<ReturnType<typeof makeDb>>> {
  if (!instance) instance = await makeDb(databaseUrl);
  return instance;
}

export function getDb(): Awaited<ReturnType<typeof makeDb>>['db'] {
  if (!instance) throw new Error('getDb() before initDb()');
  return instance.db;
}

/** The raw postgres.js client behind the pool (LISTEN/NOTIFY, tagged SQL). */
export function getSql(): Awaited<ReturnType<typeof makeDb>>['client'] {
  if (!instance) throw new Error('getSql() before initDb()');
  return instance.client;
}

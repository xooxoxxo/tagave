/**
 * A pgboss.job stand-in on the shared test database: pg-boss never runs in
 * the worker's db tests, but some code reads its job table. Suites share the
 * database and run in parallel, so a suite never empties or drops a table
 * another suite may be using: it removes only its own rows, and drops the
 * table only when it created it and no other rows are left.
 */
import type postgres from 'postgres';

const IGNORABLE = new Set(['42P06', '42P07', '23505']); // schema / table already exists (a parallel create)

/** Creates pgboss.job when it is missing; true when this call created it. */
export async function ensureFakeBossJob(sql: postgres.Sql): Promise<boolean> {
  const [before] = await sql`select to_regclass('pgboss.job') is not null as present`;
  if (before!['present']) return false;
  try {
    await sql`create schema if not exists pgboss`;
    await sql`create table if not exists pgboss.job (
      id uuid default gen_random_uuid(), name text, state text, priority int default 0, singleton_key text, data jsonb)`;
  } catch (err) {
    if (!IGNORABLE.has((err as { code?: string }).code ?? '')) throw err;
    return false;
  }
  return true;
}

/** Deletes this suite's rows; drops the table when this suite created it and nothing else is in it. */
export async function releaseFakeBossJob(sql: postgres.Sql, created: boolean, ids: readonly string[]): Promise<void> {
  if (ids.length) await sql`delete from pgboss.job where id = any(${[...ids]}::uuid[])`;
  if (!created) return;
  const [left] = await sql`select count(*)::int as n from pgboss.job`;
  if (left!['n'] === 0) await sql`drop table if exists pgboss.job`;
}

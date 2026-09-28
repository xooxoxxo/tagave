import { asc } from 'drizzle-orm';
import { libraries } from '@liner/db';
import type { WorkerContext } from './context.js';

/**
 * The library a scheduled job is pinned to, from LINER_LIBRARY_ID. Empty or
 * blank means none: compose files pass `${LINER_LIBRARY_ID:-}`, and `??`
 * would otherwise keep the empty string as a library id.
 */
export function pinnedLibraryId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.LINER_LIBRARY_ID?.trim();
  return value ? value : undefined;
}

/**
 * The libraries a library-wide job runs for: the one the job names, or every
 * library in the database when it names none (the nightly schedules send no
 * id, so a fresh install runs them for whatever library it created).
 */
export async function libraryIdsFor(ctx: Pick<WorkerContext, 'db'>, requested?: string | null): Promise<string[]> {
  const id = requested?.trim();
  if (id) return [id];
  const rows = await ctx.db.select({ id: libraries.id }).from(libraries).orderBy(asc(libraries.id));
  return rows.map((r) => r.id);
}

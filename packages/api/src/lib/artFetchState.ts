/**
 * Where an album's cover-art lookup (art.fetch) stands, so the album page can
 * say "Looking for cover art…" while it runs and drop the note when it ends,
 * instead of a fixed "queued" sentence that never went away.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db.js';

export interface ArtFetchView {
  state: 'queued' | 'running' | 'done' | 'failed';
  /** when the last lookup ended (done or failed); null while it is live */
  finishedAt: string | null;
}

/** pg-boss job state to the view; null for a cancelled or unknown job. */
export function artFetchViewOf(row: { state: string; completed_on: Date | string | null } | undefined): ArtFetchView | null {
  if (!row) return null;
  const finishedAt = row.completed_on ? new Date(row.completed_on).toISOString() : null;
  switch (row.state) {
    case 'created':
    case 'retry':
      return { state: 'queued', finishedAt: null };
    case 'active':
      return { state: 'running', finishedAt: null };
    case 'completed':
      return { state: 'done', finishedAt };
    case 'failed':
      return { state: 'failed', finishedAt };
    default:
      return null;
  }
}

/** The album's latest art.fetch job, as a view. */
export async function artFetchState(albumId: string): Promise<ArtFetchView | null> {
  let rows: Array<{ state: string; completed_on: Date | string | null }>;
  try {
    rows = (await getDb().execute(sql`
    select state::text as state, completed_on
      from pgboss.job
     where name = 'art.fetch' and singleton_key = ${`art:${albumId}`}
     order by created_on desc
     limit 1`)) as unknown as Array<{ state: string; completed_on: Date | string | null }>;
  } catch {
    return null; // no job queue schema yet (a fresh install before the worker started)
  }
  return artFetchViewOf(rows[0]);
}

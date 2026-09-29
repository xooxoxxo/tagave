/**
 * Outcome of an owner-requested identification, recorded when identify.album
 * ends (identify_runs, migration 0032). The album page reads the newest row
 * beside the live pg-boss job, so a request that failed says why instead of
 * sitting "queued" forever.
 */
import type { IdentifyOutcomeKind, IdentifyRequestKind, ReleaseChoice } from '@liner/shared';
import type { WorkerContext } from './context.js';

export interface IdentifyOutcome {
  outcome: IdentifyOutcomeKind;
  message: string;
  detail?: {
    releaseGroup?: { mbid: string; title: string };
    choices?: ReleaseChoice[];
    moreChoices?: number;
    releaseTitle?: string;
  };
}

export interface ManualRequestData {
  force?: boolean;
  pinnedMbid?: string;
  pinnedReleaseGroup?: string;
  pinnedDiscogs?: { kind: 'release' | 'master'; id: number };
}

/** Pinned or forced: an owner click, not the sweep. */
export function isManualRequest(data: ManualRequestData): boolean {
  return !!(data.pinnedMbid || data.pinnedReleaseGroup || data.pinnedDiscogs || data.force);
}

export function requestKindOf(data: ManualRequestData): { kind: IdentifyRequestKind; pinned: string | null } {
  if (data.pinnedReleaseGroup) return { kind: 'release_group', pinned: data.pinnedReleaseGroup };
  if (data.pinnedMbid) return { kind: 'mbid', pinned: data.pinnedMbid };
  if (data.pinnedDiscogs) return { kind: 'discogs', pinned: `${data.pinnedDiscogs.kind}:${data.pinnedDiscogs.id}` };
  return { kind: data.force ? 'reidentify' : 'sweep', pinned: null };
}

/** A thrown error as a sentence the owner can act on. */
export function plainFailure(err: unknown): string {
  const msg = (err as Error | null)?.message ?? String(err);
  if (/timed out/i.test(msg)) return 'The lookup took too long (the providers are busy). It will be tried again.';
  if (/rate limit|503|busy/i.test(msg)) return 'MusicBrainz or Discogs is busy right now. It will be tried again.';
  if (/contact/i.test(msg)) return 'Provider lookups are off until a contact email is set in Settings › Providers.';
  return `The lookup failed: ${msg}`;
}

/** Insert one row; nothing when the album is gone (merged or regrouped). */
export async function recordIdentifyOutcome(
  ctx: WorkerContext,
  data: ManualRequestData & { localAlbumId: string },
  jobId: string | undefined,
  o: IdentifyOutcome,
): Promise<void> {
  const { kind, pinned } = requestKindOf(data);
  try {
    await ctx.sql`
      insert into identify_runs (library_id, local_album_id, job_id, kind, pinned, outcome, message, detail)
      select la.library_id, la.id, ${jobId ?? null}, ${kind}, ${pinned}, ${o.outcome}, ${o.message},
             ${o.detail ? JSON.stringify(o.detail) : null}::text::jsonb
        from local_albums la where la.id = ${data.localAlbumId}`;
  } catch (err) {
    // bookkeeping must never fail the identification itself
    ctx.logger.warn({ localAlbumId: data.localAlbumId, err: (err as Error).message }, 'identify: could not record outcome');
  }
}

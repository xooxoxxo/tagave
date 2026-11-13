/**
 * similarArtists.fetch: an artist's similar artists (the similar-artists
 * module).
 *
 *   { artistId }    one artist (its page was opened and the list is
 *                   missing or a week old)
 *   { sweep: true } daily: up to SWEEP_ARTISTS lists that are a week old
 *
 * Skips when the module is off (Settings › Modules), and when the install
 * has no contact string (the providers' User-Agent). An artist without a
 * MusicBrainz id has nothing to ask by.
 *
 * Asks ListenBrainz by the artist's MBID and, when the install has a Last.fm
 * API key (the player's scrobbling application), Last.fm by the same MBID;
 * merges the two (core › similarArtists). Calls run in the shared pacers
 * (ListenBrainz 1 req/s, Last.fm 1 req/s). ListenBrainz failing records the
 * error (the list from before stays, it is asked again after a day); Last.fm
 * failing leaves its part out.
 */
import { recordSimilarArtistsError, saveSimilarArtists, similarArtistsEnabled } from '@tagave/db';
import { SIMILAR_REFRESH_DAYS, SIMILAR_RETRY_DAYS, SimilarArtistsClient, mergeSimilar, similarDue, type SimilarProvider } from '@tagave/core/similar-artists';
import type { WorkerContext } from '../lib/context.js';
import { installLastfmApiKey, installUserAgent } from '../lib/providers.js';
import { PROVIDER_INTERVALS, paced } from '../lib/pacer.js';

export interface SimilarArtistsFetchJobData {
  artistId?: string;
  sweep?: boolean;
  /** fetch again even when the list is recent */
  force?: boolean;
}

export const SWEEP_ARTISTS = 30;

type Result = { skipped: string } | { artists: number; similar: number; failed: number };

/** The client as the worker runs it: the install's User-Agent, the shared pacers. Tests pass their own. */
export type SimilarClientFactory = (userAgent: string) => SimilarArtistsClient;

const defaultClient = (ctx: WorkerContext): SimilarClientFactory => (userAgent) => new SimilarArtistsClient({
  userAgent,
  // ListenBrainz retries a rate limit as every job does; Last.fm is optional: one try
  pace: <T>(provider: SimilarProvider, fn: () => Promise<T>) =>
    paced(ctx.sql, provider, PROVIDER_INTERVALS[provider], fn, provider === 'listenbrainz' ? {} : { maxAttempts: 1 }),
});

export async function similarArtistsFetchJob(
  ctx: WorkerContext,
  data: SimilarArtistsFetchJobData = {},
  makeClient?: SimilarClientFactory,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result> {
  if (!(await similarArtistsEnabled(ctx.sql))) return { skipped: 'similar artists is off' };
  const ua = await installUserAgent(ctx);
  if (!ua) return { skipped: 'no contact string (Settings › Integrations)' };
  const client = (makeClient ?? defaultClient(ctx))(ua);
  const lastfmKey = await installLastfmApiKey(ctx, env);
  const force = data.force === true;
  const out = { artists: 0, similar: 0, failed: 0 };

  const doArtist = async (artistId: string) => {
    const [a] = await ctx.sql<Array<{ mbid: string | null; name: string; fetched_at: Date | null; error: string | null }>>`
      select a.mbid::text as mbid, a.name, c.fetched_at, c.error
        from artists a left join similar_artist_checks c on c.artist_id = a.id where a.id = ${artistId}`;
    if (!a?.mbid) return;
    if (!force && !similarDue(a.fetched_at ? { fetchedAt: a.fetched_at, error: a.error } : null)) return;
    let lb;
    try {
      lb = await client.listenbrainz(a.mbid);
    } catch (err) {
      out.failed++;
      ctx.logger.warn({ job: 'similarArtists.fetch', artistId, err: (err as Error).message }, 'similar artists: ListenBrainz failed');
      await recordSimilarArtistsError(ctx.sql, artistId, (err as Error).message);
      return;
    }
    let fm = null;
    if (lastfmKey) {
      try {
        fm = await client.lastfm(a.mbid, lastfmKey);
      } catch (err) {
        ctx.logger.warn({ job: 'similarArtists.fetch', artistId, err: (err as Error).message }, 'similar artists: Last.fm failed, ListenBrainz alone');
      }
    }
    const merged = mergeSimilar(lb, fm, { exclude: { mbid: a.mbid, name: a.name } });
    await saveSimilarArtists(ctx.sql, artistId, merged, fm ? ['lastfm', 'listenbrainz'] : ['listenbrainz']);
    out.artists++;
    out.similar += merged.length;
  };

  if (data.artistId) await doArtist(data.artistId);
  if (data.sweep) {
    const due = await ctx.sql<Array<{ artist_id: string }>>`
      select c.artist_id::text as artist_id from similar_artist_checks c
       where c.fetched_at < now() - (case when c.error is not null then ${`${SIMILAR_RETRY_DAYS} days`}::interval else ${`${SIMILAR_REFRESH_DAYS} days`}::interval end)
       order by c.fetched_at limit ${SWEEP_ARTISTS}`;
    for (const r of due) await doArtist(r.artist_id);
  }
  ctx.logger.info({ job: 'similarArtists.fetch', ...out }, 'similar artists fetched');
  return out;
}

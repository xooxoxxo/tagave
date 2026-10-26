/**
 * listenLinks.resolve: find albums' and artists' links on the streaming
 * platforms people picked (Listen elsewhere, the listen-links module).
 *
 *   { releaseGroupId }  one album (its album page was opened), and its first artist
 *   { artistId }        an artist (its page was opened) and the albums it is missing
 *   { sweep: true }     nightly: a few followed artists' missing albums not looked up yet
 *
 * Skips when the module is off (Settings › Modules), when nobody picked a
 * platform, and when the library has no contact string (the providers'
 * User-Agent). Only platforms someone picked are looked for. A lookup is
 * done again after 30 days when it found links and after 14 when it found
 * none (listen_*_checks); found links replace the earlier ones of the
 * platforms looked for.
 *
 * Calls run in the shared pacers (MusicBrainz 1 req/s with identification,
 * Wikidata, Apple 15 a minute), on the identify worker. Each job is bounded
 * (an artist's missing albums: 12, the sweep: 20 albums), so it never holds
 * MusicBrainz for long.
 */
import { listenLinksEnabled, pickedListenPlatforms } from '@tagave/db';
import { ListenLinkResolver, listenCheckDue, type ListenProvider, type ResolveResult } from '@tagave/core/listen-links';
import { LISTEN_PLATFORMS, type ListenPlatform } from '@tagave/shared';
import type { WorkerContext } from '../lib/context.js';
import { libraryProviderSettings } from '../lib/providers.js';
import { PROVIDER_INTERVALS, paced } from '../lib/pacer.js';

export interface ListenLinksResolveJobData {
  releaseGroupId?: string;
  artistId?: string;
  sweep?: boolean;
  /** look again even when the last lookup is recent */
  force?: boolean;
}

export const ARTIST_ALBUMS_PER_JOB = 12;
export const SWEEP_ALBUMS = 20;

type Result = { skipped: string } | { albums: number; artists: number; links: number };

/** The resolver as the worker runs it: the install's User-Agent, the shared pacers. Tests pass their own. */
export type ResolverFactory = (userAgent: string) => ListenLinkResolver;

const defaultResolver = (ctx: WorkerContext): ResolverFactory => (userAgent) => new ListenLinkResolver({
  userAgent,
  // MusicBrainz retries a rate limit as every job does; Wikidata and Apple are
  // optional sources: one try (a 429 still opens their shared cooldown)
  pace: <T>(provider: ListenProvider, fn: () => Promise<T>) =>
    paced(ctx.sql, provider, PROVIDER_INTERVALS[provider], fn, provider === 'musicbrainz' ? {} : { maxAttempts: 1 }),
});

async function userAgentOf(ctx: WorkerContext): Promise<string | null> {
  const [lib] = await ctx.sql<Array<{ id: string }>>`
    select id from libraries order by (settings->>'contactString') is null, created_at, id limit 1`;
  if (!lib) return null;
  const s = await libraryProviderSettings(ctx, lib.id);
  return s.contactString ? `tagave/0.1 (+${s.contactString})` : null;
}

/**
 * Store one lookup. An incomplete one (Wikidata or Apple did not answer)
 * records no platforms, so the next view or sweep asks again.
 */
async function saveAlbum(ctx: WorkerContext, rgId: string, platforms: readonly ListenPlatform[], { links, incomplete }: ResolveResult): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    await tx`delete from listen_links where release_group_id = ${rgId} and platform = any(${platforms as string[]}::text[])`;
    for (const l of links) {
      await tx`insert into listen_links (release_group_id, platform, url, source) values (${rgId}, ${l.platform}, ${l.url}, ${l.source})
               on conflict (release_group_id, platform) do update set url = excluded.url, source = excluded.source, resolved_at = now()`;
    }
    await tx`insert into listen_album_checks (release_group_id, checked_at, platforms, found) values (${rgId}, now(), ${(incomplete ? [] : platforms) as string[]}::text[], ${links.length})
             on conflict (release_group_id) do update set checked_at = now(), platforms = excluded.platforms, found = excluded.found`;
  });
}

async function saveArtist(ctx: WorkerContext, artistId: string, platforms: readonly ListenPlatform[], { links, incomplete }: ResolveResult): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    await tx`delete from listen_artist_links where artist_id = ${artistId} and platform = any(${platforms as string[]}::text[])`;
    for (const l of links) {
      await tx`insert into listen_artist_links (artist_id, platform, url, source) values (${artistId}, ${l.platform}, ${l.url}, ${l.source})
               on conflict (artist_id, platform) do update set url = excluded.url, source = excluded.source, resolved_at = now()`;
    }
    await tx`insert into listen_artist_checks (artist_id, checked_at, platforms, found) values (${artistId}, now(), ${(incomplete ? [] : platforms) as string[]}::text[], ${links.length})
             on conflict (artist_id) do update set checked_at = now(), platforms = excluded.platforms, found = excluded.found`;
  });
}

export async function listenLinksResolveJob(ctx: WorkerContext, data: ListenLinksResolveJobData = {}, makeResolver?: ResolverFactory): Promise<Result> {
  if (!(await listenLinksEnabled(ctx.sql))) return { skipped: 'listen elsewhere is off' };
  const platforms = (await pickedListenPlatforms(ctx.sql)).filter((p): p is ListenPlatform => (LISTEN_PLATFORMS as readonly string[]).includes(p));
  if (platforms.length === 0) return { skipped: 'nobody picked a platform' };
  const ua = await userAgentOf(ctx);
  if (!ua) return { skipped: 'no contact string (Settings › Integrations)' };
  const resolver = (makeResolver ?? defaultResolver(ctx))(ua);
  const force = data.force === true;
  const out = { albums: 0, artists: 0, links: 0 };

  const doAlbum = async (rgId: string) => {
    const [rg] = await ctx.sql<Array<{ mbid: string | null; title: string; checked_at: Date | null; found: number | null; platforms: string[] | null }>>`
      select rg.mbid::text as mbid, rg.title, c.checked_at, c.found, c.platforms
        from release_groups rg left join listen_album_checks c on c.release_group_id = rg.id
       where rg.id = ${rgId}`;
    if (!rg?.mbid) return;
    if (!force && !listenCheckDue(rg.checked_at ? { checkedAt: rg.checked_at, found: rg.found ?? 0, platforms: rg.platforms ?? [] } : null, platforms)) return;
    const found = await resolver.album({ mbid: rg.mbid, title: rg.title }, platforms);
    await saveAlbum(ctx, rgId, platforms, found);
    out.albums++;
    out.links += found.links.length;
  };
  const doArtist = async (artistId: string) => {
    const [a] = await ctx.sql<Array<{ mbid: string | null; checked_at: Date | null; found: number | null; platforms: string[] | null }>>`
      select a.mbid::text as mbid, c.checked_at, c.found, c.platforms from artists a left join listen_artist_checks c on c.artist_id = a.id where a.id = ${artistId}`;
    if (!a?.mbid) return;
    if (!force && !listenCheckDue(a.checked_at ? { checkedAt: a.checked_at, found: a.found ?? 0, platforms: a.platforms ?? [] } : null, platforms)) return;
    const found = await resolver.artist(a.mbid, platforms);
    await saveArtist(ctx, artistId, platforms, found);
    out.artists++;
    out.links += found.links.length;
  };
  /** the artist's missing albums (any library), not looked up lately */
  const missingOf = async (artistId: string | null, limit: number) => ctx.sql<Array<{ id: string; artist_id: string | null }>>`
    select distinct on (g.subject_id) g.subject_id as id,
           (select rga.artist_id from release_group_artists rga where rga.release_group_id = g.subject_id order by rga.position limit 1) as artist_id,
           c.checked_at
      from gaps g
      join release_groups rg on rg.id = g.subject_id and rg.mbid is not null
      left join listen_album_checks c on c.release_group_id = g.subject_id
     where g.kind = 'missing_album' and g.state = 'open'
       and (${artistId}::uuid is null or exists (select 1 from release_group_artists rga where rga.release_group_id = g.subject_id and rga.artist_id = ${artistId}))
       and (${force} or c.checked_at is null or not (c.platforms @> ${platforms as string[]}::text[])
            or c.checked_at < now() - (case when c.found > 0 then interval '30 days' else interval '14 days' end))
     order by g.subject_id, c.checked_at nulls first
     limit ${limit}`;

  if (data.releaseGroupId) {
    await doAlbum(data.releaseGroupId);
    const [first] = await ctx.sql<Array<{ artist_id: string }>>`
      select artist_id from release_group_artists where release_group_id = ${data.releaseGroupId} order by position limit 1`;
    if (first) await doArtist(first.artist_id);
  }
  if (data.artistId) {
    await doArtist(data.artistId);
    for (const rg of await missingOf(data.artistId, ARTIST_ALBUMS_PER_JOB)) await doAlbum(rg.id);
  }
  if (data.sweep) {
    const due = await missingOf(null, SWEEP_ALBUMS);
    for (const rg of due) await doAlbum(rg.id);
    for (const artistId of new Set(due.map((r) => r.artist_id).filter((x): x is string => !!x))) await doArtist(artistId);
  }
  ctx.logger.info({ job: 'listenLinks.resolve', ...out }, 'listen links resolved');
  return out;
}

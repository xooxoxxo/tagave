/**
 * Refresh a followed artist's discography from MusicBrainz (XO-348, GAP-2).
 *
 * One browse request per 100 release groups, server-filtered to the primary
 * types the artist's follow rules include, then set-based writes:
 * release_groups upserted by mbid, artists upserted by mbid, and each group's
 * release_group_artists replaced with the full MB credit (position, credited
 * name, join phrase) — the same rows artists.resolve writes, so the two jobs
 * never disagree. Ends with a missing_album gap pass scoped to this artist so
 * the artist page and the Attention list reflect the refresh at once, then
 * sets followed_artists.last_refreshed_at.
 *
 * Fetched groups are kept whatever their secondary types; the gap pass applies
 * excludeSecondary, so loosening that rule needs no refetch.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { MusicBrainzProvider } from '@liner/core';
import { artists, releaseGroups, followedArtists } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, getProviders, libraryProviderSettings, type Providers } from '../lib/providers.js';
import { cached, cacheKey } from '../lib/providerCache.js';
import { isRateLimitError } from '../lib/pacer.js';
import { normDate } from '../lib/canonical.js';
import { effectiveFollowRules, loadLibraryFollowRules, type EffectiveFollowRules } from '../lib/followRules.js';
import { recomputeMissingAlbumGaps } from '../lib/missingAlbumGaps.js';

type BrowsePage = Awaited<ReturnType<MusicBrainzProvider['browseArtistReleaseGroups']>>;
type BrowsedReleaseGroup = BrowsePage['items'][number];

export interface ArtistRefreshJobData {
  libraryId: string;
  artistId: string;
  /** manual refresh from the artist page: bypass the browse cache */
  force?: boolean;
}

const bg = { priority: 'background' as const };
/** MusicBrainz caps browse pages at 100. */
const PAGE_SIZE = 100;
/** Ten pages bound prolific artists (Pink Floyd: 526 album/EP groups); anything past that is logged as truncated. */
const MAX_PAGES = 10;
/** Shorter than the weekly sweep so each sweep refetches; the 30-day artist TTL would make it a no-op. */
const BROWSE_TTL_S = 6 * 24 * 3600;
const RG_CHUNK = 200;
const LINK_CHUNK = 500;

export async function artistRefreshJob(ctx: WorkerContext, data: ArtistRefreshJobData): Promise<void> {
  const { libraryId, artistId } = data;
  const force = data.force === true;

  const [artist] = await ctx.db.select().from(artists).where(eq(artists.id, artistId)).limit(1);
  if (!artist) {
    ctx.logger.warn({ artistId }, 'artist.refresh: not found');
    return;
  }

  const [follow] = await ctx.db.select().from(followedArtists)
    .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)))
    .limit(1);
  if (!follow) {
    ctx.logger.warn({ artistId, libraryId }, 'artist.refresh: not followed');
    return;
  }

  if (!artist.mbid) {
    ctx.logger.debug({ artistId }, 'artist.refresh: no mbid');
    return;
  }
  const mbid = artist.mbid;

  let providers: Providers;
  try {
    providers = getProviders(await libraryProviderSettings(ctx, libraryId));
  } catch (err) {
    ctx.logger.warn({ artistId, err: (err as Error).message }, 'artist.refresh: providers failed');
    return;
  }

  const rules = effectiveFollowRules(await loadLibraryFollowRules(ctx, libraryId), follow);

  const markRefreshed = () => ctx.db.update(followedArtists)
    .set({ lastRefreshedAt: new Date() })
    .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

  try {
    const browsed = await browseAll(ctx, providers, mbid, rules, force);
    // The server already filtered by primary type; keep the check in case MB
    // ever returns more than asked. Secondary types are left to the gap pass.
    const wanted = dedupeByMbid(browsed.items.filter(
      (rg) => rg.primaryType !== null && rules.includePrimary.includes(rg.primaryType),
    ));

    const idByMbid = await upsertReleaseGroups(ctx, wanted);
    await replaceCredits(ctx, wanted, idByMbid, { mbid, name: artist.name });
    await recomputeMissingAlbumGaps(ctx, libraryId, { artistId });
    await markRefreshed();

    ctx.logger.info({
      artistId, mbid, releaseGroups: wanted.length, total: browsed.total,
      pages: browsed.pages, truncated: browsed.truncated, force,
    }, 'artist.refresh: done');
  } catch (err) {
    if (isRateLimitError(err)) throw err; // pg-boss retries after the cooldown
    if ((err as { status?: number }).status === 404) {
      // Gone from MusicBrainz (merged or deleted id): nothing to fetch until
      // the artist row gets a new mbid; count the run so the sweep moves on.
      ctx.logger.warn({ artistId, mbid }, 'artist.refresh: artist not found on MusicBrainz (404)');
      await markRefreshed();
      return;
    }
    ctx.logger.warn({ artistId, mbid, err: (err as Error).message }, 'artist.refresh: failed');
  }
}

async function browseAll(
  ctx: WorkerContext,
  providers: Providers,
  mbid: string,
  rules: EffectiveFollowRules,
  force: boolean,
): Promise<{ items: BrowsedReleaseGroup[]; total: number; pages: number; truncated: boolean }> {
  const items: BrowsedReleaseGroup[] = [];
  const typesKey = rules.includePrimary.map((t) => t.toLowerCase()).sort().join('|');
  let total = 0;
  let pages = 0;

  for (let offset = 0; pages < MAX_PAGES; offset += PAGE_SIZE) {
    const page = await cached<BrowsePage>(
      ctx.sql,
      'musicbrainz',
      cacheKey('artist-rg-browse', mbid, typesKey, offset),
      BROWSE_TTL_S,
      () => mbCall(ctx, () => providers.mb.browseArtistReleaseGroups(mbid, bg, {
        types: rules.includePrimary, offset, limit: PAGE_SIZE,
      })),
      { bypass: force },
    );
    pages++;
    total = page.total;
    items.push(...page.items);
    if (page.items.length === 0 || offset + page.items.length >= total) {
      return { items, total, pages, truncated: false };
    }
  }

  ctx.logger.warn({ mbid, total, fetched: items.length }, 'artist.refresh: release groups truncated at the page cap');
  return { items, total, pages, truncated: true };
}

function dedupeByMbid(rgs: BrowsedReleaseGroup[]): BrowsedReleaseGroup[] {
  const seen = new Set<string>();
  return rgs.filter((rg) => (seen.has(rg.mbid) ? false : (seen.add(rg.mbid), true)));
}

/** release_groups by mbid, one statement per chunk; returns mbid → row id. */
async function upsertReleaseGroups(ctx: WorkerContext, rgs: BrowsedReleaseGroup[]): Promise<Map<string, string>> {
  const idByMbid = new Map<string, string>();
  for (let i = 0; i < rgs.length; i += RG_CHUNK) {
    const chunk = rgs.slice(i, i + RG_CHUNK);
    const rows = await ctx.db.insert(releaseGroups)
      .values(chunk.map((rg) => ({
        mbid: rg.mbid,
        title: rg.title.slice(0, 255),
        primaryType: rg.primaryType,
        secondaryTypes: rg.secondaryTypes,
        firstReleaseDate: normDate(rg.firstReleaseDate ?? undefined),
        artistCredit: rg.artistCredits.map((c) => c.name),
        fetchedAt: new Date(),
      })))
      .onConflictDoUpdate({
        target: releaseGroups.mbid,
        set: {
          title: sql`excluded.title`,
          primaryType: sql`excluded.primary_type`,
          secondaryTypes: sql`excluded.secondary_types`,
          // partial MB dates normalise to null; never blank a date identify stored
          firstReleaseDate: sql`coalesce(excluded.first_release_date, ${releaseGroups.firstReleaseDate})`,
          artistCredit: sql`excluded.artist_credit`,
          fetchedAt: new Date(),
        },
      })
      .returning({ id: releaseGroups.id, mbid: releaseGroups.mbid });
    for (const row of rows) if (row.mbid) idByMbid.set(row.mbid, row.id);
  }
  return idByMbid;
}

interface CreditLink {
  rgId: string;
  mbid: string;
  name: string;
  position: number;
  creditedName: string;
  joinPhrase: string | null;
}

/**
 * Replace each group's credit rows with MusicBrainz's list. Artists are
 * upserted by mbid first (never overwriting an enriched name); the delete and
 * the insert run in one transaction so a crash cannot leave a group linkless.
 */
async function replaceCredits(
  ctx: WorkerContext,
  rgs: BrowsedReleaseGroup[],
  idByMbid: Map<string, string>,
  followed: { mbid: string; name: string },
): Promise<void> {
  const links: CreditLink[] = [];
  for (const rg of rgs) {
    const rgId = idByMbid.get(rg.mbid);
    if (!rgId) continue;
    const rows: CreditLink[] = rg.artistCredits
      .filter((c): c is typeof c & { mbid: string } => typeof c.mbid === 'string' && c.mbid.length > 0)
      .map((c, position) => ({
        rgId,
        mbid: c.mbid,
        name: c.name.trim(),
        position,
        creditedName: c.name.trim(),
        joinPhrase: c.joinPhrase ?? null,
      }));
    // The browse lists this artist's groups, so the credit normally names them;
    // when it does not, keep a link so the group still counts as theirs.
    if (!rows.some((r) => r.mbid === followed.mbid)) {
      rows.push({ rgId, mbid: followed.mbid, name: followed.name, position: rows.length, creditedName: followed.name, joinPhrase: null });
    }
    links.push(...rows);
  }
  if (links.length === 0) return;

  const uniqueArtists = [...new Map(links.map((l) => [l.mbid, l])).values()];
  await ctx.sql`
    insert into artists (mbid, name)
    select c.mbid, c.name
      from unnest(${uniqueArtists.map((l) => l.mbid)}::text[], ${uniqueArtists.map((l) => l.name)}::text[]) as c(mbid, name)
    on conflict (mbid) do update
      set name = case when artists.name = '' or artists.name is null then excluded.name else artists.name end`;

  const rgIds = [...new Set(links.map((l) => l.rgId))];
  await ctx.sql.begin(async (tx) => {
    await tx`delete from release_group_artists where release_group_id = any(${rgIds}::uuid[])`;
    for (let i = 0; i < links.length; i += LINK_CHUNK) {
      const c = links.slice(i, i + LINK_CHUNK);
      await tx`
        insert into release_group_artists (release_group_id, artist_id, position, credited_name, join_phrase)
        select c.rg_id, a.id, c.position, c.credited_name, c.join_phrase
          from unnest(${c.map((l) => l.rgId)}::uuid[], ${c.map((l) => l.mbid)}::text[], ${c.map((l) => l.position)}::int[],
                      ${c.map((l) => l.creditedName)}::text[], ${c.map((l) => l.joinPhrase)}::text[])
               as c(rg_id, mbid, position, credited_name, join_phrase)
          join artists a on a.mbid = c.mbid
        on conflict do nothing`;
    }
  });
}

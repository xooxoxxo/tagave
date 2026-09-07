/**
 * Enrich artist with MusicBrainz and Wikipedia data (spec XO-310, §5).
 */
import { eq } from 'drizzle-orm';
import { artists, externalIds } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, wikidataCall, wikipediaCall, type Providers } from '../lib/providers.js';
import { cached, cacheKey, TTLs } from '../lib/providerCache.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';
import { isRateLimitError } from '../lib/pacer.js';

export interface ArtistsEnrichJobData {
  artistId: string;
  force?: boolean;
}

const bg = { priority: 'background' as const };

/**
 * Extract wikidata QID and wikipedia title from MB artist's URL relations.
 */
export interface UrlRelIdentity {
  wikidataQid?: string | undefined;
  wikipediaTitle?: string | undefined;
}

export function extractIdentityFromUrlRels(
  urlRelations: Array<{ type: string; url: string }> | undefined,
): UrlRelIdentity {
  if (!urlRelations || urlRelations.length === 0) return {};

  let wikidataQid: string | undefined;
  let wikipediaTitle: string | undefined;

  for (const rel of urlRelations) {
    // Wikidata: https://www.wikidata.org/wiki/Q123
    if (rel.type === 'wikidata' || rel.url.includes('wikidata.org')) {
      const match = rel.url.match(/Q\d+/);
      if (match) wikidataQid = match[0];
    }

    // Wikipedia: https://en.wikipedia.org/wiki/Article_Title
    if (rel.type === 'wikipedia' || rel.url.includes('wikipedia.org')) {
      const match = rel.url.match(/wiki\/(.+?)(?:[#?]|$)/);
      if (match) wikipediaTitle = decodeURIComponent(match[1]!);
    }
  }

  const result: UrlRelIdentity = {};
  if (wikidataQid !== undefined) result.wikidataQid = wikidataQid;
  if (wikipediaTitle !== undefined) result.wikipediaTitle = wikipediaTitle;
  return result;
}

/**
 * Check if artist enrichment is stale (older than 7 days).
 */
export function isStale(enrichedAt: Date | null | undefined, now: Date): boolean {
  if (!enrichedAt) return true;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  return now.getTime() - enrichedAt.getTime() > sevenDaysMs;
}

/**
 * Enrich a single artist with MB, Wikidata, and Wikipedia data.
 */
export async function artistsEnrichJob(ctx: WorkerContext, data: ArtistsEnrichJobData): Promise<void> {
  const artistId = data.artistId;

  // Load the artist
  const rows = await ctx.db.select().from(artists).where(eq(artists.id, artistId)).limit(1);
  const artist = rows[0];
  if (!artist) {
    ctx.logger.warn({ artistId }, 'enrich artist: not found');
    return;
  }

  // Skip if already enriched recently (unless force)
  const now = new Date();
  if (!data.force && !isStale(artist.enrichedAt, now)) {
    ctx.logger.debug({ artistId }, 'enrich artist: fresh, skipping');
    return;
  }

  // Find a library context (any library with this artist's albums)
  const libRow = await ctx.sql`
    select l.id from libraries l
    join local_albums la on la.library_id = l.id
    join release_group_artists rga on rga.release_group_id = la.release_group_id
    where rga.artist_id = ${artistId}
    limit 1
  ` as unknown as Array<{ id: string }>;

  if (!libRow[0]) {
    // No library context, fall back to first library
    const libRows = await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>;
    if (!libRows[0]) {
      ctx.logger.warn({ artistId }, 'enrich artist: no library found');
      return;
    }
  }

  const libraryId = libRow[0]?.id || (await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>)[0]!.id;

  let providers: Providers;
  try {
    const settings = await libraryProviderSettings(ctx, libraryId);
    providers = getProviders(settings);
  } catch (err) {
    ctx.logger.warn({ artistId, err }, 'enrich artist: providers failed');
    return;
  }

  try {
    // 1. Fetch MB artist and update fields
    if (!artist.mbid) {
      ctx.logger.debug({ artistId }, 'enrich artist: no mbid, skipping');
      return;
    }

    const mbArtist = await cached(
      ctx.sql,
      'musicbrainz',
      cacheKey('artist', artist.mbid),
      TTLs.mbArtist,
      () => mbCall(ctx, () => providers.mb.getArtist(artist.mbid!, bg)),
    );

    // Update artist fields from MB
    await ctx.db.update(artists)
      .set({
        sortName: mbArtist.sortName || null,
        type: mbArtist.type || null,
        country: mbArtist.country || null,
        beginDate: mbArtist.beginDate || null,
        endDate: mbArtist.endDate || null,
        disambiguation: mbArtist.disambiguation || null,
        aliases: mbArtist.aliases || [],
      })
      .where(eq(artists.id, artistId));

    // 2. Extract wikidata/wikipedia from MB url-rels
    const { wikidataQid, wikipediaTitle } = extractIdentityFromUrlRels(mbArtist.urlRelations);

    // Write wikidata external_ids if found from MB
    if (wikidataQid) {
      await ctx.sql`
        insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
        values ('wikidata', ${wikidataQid}, 'artist', ${artistId}::uuid, ${'https://www.wikidata.org/wiki/' + wikidataQid}, '1.0000', 'musicbrainz')
        on conflict do nothing
      `;
    }

    // Write wikipedia external_ids if found from MB
    if (wikipediaTitle) {
      await ctx.sql`
        insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
        values ('wikipedia', ${wikipediaTitle}, 'artist', ${artistId}::uuid, ${'https://en.wikipedia.org/wiki/' + encodeURIComponent(wikipediaTitle)}, '1.0000', 'musicbrainz')
        on conflict do nothing
      `;
    }

    // 3. Ask Wikidata whenever the QID or the article title is still missing.
    // MusicBrainz publishes a `wikidata` relation for most artists but rarely
    // a `wikipedia` one (those were migrated to Wikidata), so keying this on
    // "no QID from MB" meant the article title — and therefore the bio — was
    // never resolved for exactly the artists MB knows best.
    let enwikiTitle = wikipediaTitle;
    if (!wikidataQid || !enwikiTitle) {
      const wdIdentity = await cached(
        ctx.sql,
        'wikidata',
        cacheKey('artist', artist.mbid),
        TTLs.wikidata,
        () => wikidataCall(ctx, () => providers.wikidata.findArtistIdentity(artist.mbid!)),
      );

      if (wdIdentity) {
        // Write wikidata external_ids
        await ctx.sql`
          insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
          values ('wikidata', ${wdIdentity.qid}, 'artist', ${artistId}::uuid, ${'https://www.wikidata.org/wiki/' + wdIdentity.qid}, '1.0000', 'wikidata')
          on conflict do nothing
        `;

        // Update enwiki title if found
        if (wdIdentity.enwikiTitle) {
          enwikiTitle = wdIdentity.enwikiTitle;
          await ctx.sql`
            insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
            values ('wikipedia', ${wdIdentity.enwikiTitle}, 'artist', ${artistId}::uuid, ${'https://en.wikipedia.org/wiki/' + encodeURIComponent(wdIdentity.enwikiTitle)}, '1.0000', 'wikidata')
            on conflict do nothing
          `;
        }

        // Update discogs_id if found
        if (wdIdentity.discogsArtistId) {
          await ctx.sql`
            insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
            values ('discogs', ${wdIdentity.discogsArtistId}, 'artist', ${artistId}::uuid, ${'https://www.discogs.com/artist/' + wdIdentity.discogsArtistId}, '1.0000', 'wikidata')
            on conflict do nothing
          `;
        }
      }
    }

    // 4. Fetch Wikipedia intro if we have an enwiki title
    if (enwikiTitle) {
      const extract = await cached(
        ctx.sql,
        'wikipedia',
        cacheKey('artist-intro', enwikiTitle),
        TTLs.wikipedia,
        () => wikipediaCall(ctx, () => providers.wikipedia.getIntroExtract(enwikiTitle!)),
      );

      if (extract) {
        const bio = {
          source: 'wikipedia',
          license: 'CC BY-SA 4.0',
          text: extract.extract,
          url: extract.url,
          title: extract.title,
          fetchedAt: new Date().toISOString(),
        };

        await ctx.db.update(artists)
          .set({ bio })
          .where(eq(artists.id, artistId));
      }
    }

    // 5. Success: set enriched_at, clear error
    await ctx.db.update(artists)
      .set({
        enrichedAt: now,
        enrichError: null,
      })
      .where(eq(artists.id, artistId));

    ctx.logger.info({ artistId, mbid: artist.mbid }, 'enrich artist: done');
  } catch (err) {
    // Rate-limit errors: rethrow for pg-boss retry
    if (isRateLimitError(err)) {
      throw err;
    }

    // Other errors: set enrich_error and continue
    const msg = err instanceof Error ? err.message : String(err);
    const errorMsg = msg.slice(0, 300);

    await ctx.db.update(artists)
      .set({ enrichError: errorMsg })
      .where(eq(artists.id, artistId));

    ctx.logger.warn({ artistId, mbid: artist.mbid, err: msg }, 'enrich artist: failed');
  }
}

/**
 * MusicBrainz metadata provider.
 * Implements spec §10.2.1, IDN-1, ENR-1, ENR-7.
 */
import { z } from 'zod';
import type {
  MetadataProvider,
  ReleaseQuery,
  ReleaseCandidate,
  CanonicalRelease,
  CanonicalTrack,
  CallContext,
  ArtistCredit,
  WeightedTag,
} from './types.js';

/**
 * Edition: a release in a release group, without track detail.
 */
export type Edition = {
  mbid: string;
  title: string;
  disambiguation?: string | null;
  status?: string | null;
  date?: string | null;
  country?: string | null;
  barcode?: string | null;
  packaging?: string | null;
  labels: Array<{ name: string; catalogNumber?: string | null }>;
  media: Array<{ position: number; format?: string | null; trackCount?: number | null }>;
  trackCount?: number | null;
};

/**
 * MusicBrainz artist with extended metadata (spec ENR-7).
 */
export type MbArtist = {
  id: string;
  name: string;
  sortName?: string | null;
  disambiguation?: string | null;
  type?: string | null;
  country?: string | null;
  beginDate?: string | null;
  endDate?: string | null;
  ended?: boolean | null;
  aliases: string[];
  urlRelations: Array<{ type: string; url: string }>;
};

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';

/** HTTP failure with the status attached, so callers can tell a stale id
 * (404 → fall back to search) from an outage (retry). */
export function mbHttpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * Zod schemas for MusicBrainz API responses.
 */

// Define RelationSchema early since it's needed by other schemas
const RelationSchema = z.object({
  type: z.string().nullish(),
  'target-type': z.string().nullish(),
  url: z.object({
    resource: z.string().nullish(),
    id: z.string().nullish(),
  }).nullish(),
});

const ArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  'sort-name': z.string().nullish(),
  type: z.string().nullish(),
  country: z.string().nullish(),
  'begin-date': z.string().nullish(),
  'end-date': z.string().nullish(),
  ended: z.boolean().nullish(),
  disambiguation: z.string().nullish(),
  aliases: z.array(z.object({
    'sort-name': z.string(),
    name: z.string(),
    primary: z.string().nullish(),
  })).optional(),
  area: z.object({
    'iso-3166-1-codes': z.array(z.string()).optional(),
  }).nullish(),
  relations: z.array(RelationSchema).optional(),
});

const RecordingSchema = z.object({
  id: z.string(),
  title: z.string(),
  length: z.number().nullish(),
  isrcs: z.array(z.string()).optional(),
  'artist-credit': z
    .array(
      z.object({
        artist: ArtistSchema,
        name: z.string().nullish(),
        joinphrase: z.string().nullish(),
      })
    )
    .optional(),
});

const NumStr = z.union([z.string(), z.number()]).transform((v) => String(v));

const TrackSchema = z.object({
  id: z.string().nullish(),
  title: z.string(),
  number: NumStr.nullish(),
  position: NumStr.nullish(),
  length: z.number().nullish(),
  recording: RecordingSchema.optional(),
  'artist-credit': z
    .array(
      z.object({
        artist: ArtistSchema,
        name: z.string().nullish(),
        joinphrase: z.string().nullish(),
      })
    )
    .optional(),
});

const MediumSchema = z.object({
  position: NumStr.nullish(),
  format: z.string().nullish(),
  'track-count': z.number().nullish(),
  tracks: z.array(TrackSchema).optional(),
});

const LabelSchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  'catalog-number': z.string().nullish(),
});

const WeightedTagSchema = z.object({
  name: z.string(),
  count: z.number().nullable(),
});

const ReleaseGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  'primary-type': z.string().nullish(),
  'secondary-types': z.array(z.string()).optional(),
  'first-release-date': z.string().nullish(),
  'artist-credit': z
    .array(
      z.object({
        artist: ArtistSchema,
        name: z.string().nullish(),
        joinphrase: z.string().nullish(),
      })
    )
    .optional(),
  genres: z.array(WeightedTagSchema).optional(),
  tags: z.array(WeightedTagSchema).optional(),
});

/**
 * Minimal release schema for editions list (no tracks).
 */
const ReleaseMinimalSchema = z.object({
  id: z.string(),
  title: z.string(),
  disambiguation: z.string().nullish(),
  status: z.string().nullish(),
  date: z.string().nullish(),
  country: z.string().nullish(),
  barcode: z.string().nullish(),
  packaging: z.string().nullish(),
  'track-count': z.number().nullish(),
  media: z.array(MediumSchema).optional(),
  'label-info': z
    .array(
      z.object({
        label: LabelSchema.nullish(),
        'catalog-number': z.string().nullish(),
      })
    )
    .optional(),
});

/**
 * Release group with releases (for editions list).
 */
const ReleaseGroupWithReleasesSchema = z.object({
  id: z.string(),
  title: z.string(),
  'primary-type': z.string().nullish(),
  'secondary-types': z.array(z.string()).optional(),
  'first-release-date': z.string().nullish(),
  releases: z.array(ReleaseMinimalSchema).optional(),
});

const ReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().nullish(),
  date: z.string().nullish(),
  country: z.string().nullish(),
  barcode: z.string().nullish(),
  'track-count': z.number().nullish(),
  'release-group': ReleaseGroupSchema.optional(),
  media: z.array(MediumSchema).optional(),
  'label-info': z
    .array(
      z.object({
        // MB omits `label` for catalogue-number-only entries (seen live on
        // the g9 identify worker); a required object here failed whole jobs.
        label: LabelSchema.nullish(),
        'catalog-number': z.string().nullish(),
      })
    )
    .optional(),
  'artist-credit': z
    .array(
      z.object({
        artist: ArtistSchema,
        name: z.string().nullish(),
        joinphrase: z.string().nullish(),
      })
    )
    .optional(),
  genres: z.array(WeightedTagSchema).optional(),
  tags: z.array(WeightedTagSchema).optional(),
  relations: z.array(RelationSchema).optional(),
});

const SearchResultSchema = z.object({
  releases: z.array(ReleaseSchema).optional(),
  'release-offset': z.number().nullish(),
  'release-count': z.number().nullish(),
});

/**
 * Extract artist credit string from artist credit array.
 */
function formatArtistCredit(
  credits?: Array<{ artist: { name: string }; name?: string | null | undefined }> | null
): string[] {
  if (!credits) return [];
  return credits.map((c) => c.name || c.artist.name);
}

/**
 * Convert MB artist credit array to ArtistCredit objects (spec ENR-7).
 */
function mbArtistCreditsToCanonical(
  credits?: Array<{ artist: { id: string; name: string }; name?: string | null | undefined; joinphrase?: string | null | undefined }> | null
): ArtistCredit[] {
  if (!credits) return [];
  return credits.map((c) => ({
    mbid: c.artist.id,
    name: c.name || c.artist.name,
    ...(c.joinphrase ? { joinPhrase: c.joinphrase } : {}),
  }));
}

/**
 * Convert MusicBrainz track to canonical format.
 */
function mbTrackToCanonical(
  mbTrack: z.infer<typeof TrackSchema>,
  mediumNumber: number
): CanonicalTrack {
  const recording = mbTrack.recording;
  const artists = formatArtistCredit(mbTrack['artist-credit'] || recording?.['artist-credit']);

  return {
    title: mbTrack.title,
    artists: artists.length > 0 ? artists : [mbTrack.title],
    duration: mbTrack.length || recording?.length || 0, // MB lengths are already milliseconds
    position: parseInt(mbTrack.position ?? mbTrack.number ?? '0', 10),
    mediumNumber,
    recordingId: recording?.id,
    isrc: recording?.isrcs?.[0],
  };
}

/**
 * Extract URL relations from relations array.
 */
export function extractUrlRelations(
  relations?: Array<{ type?: string | null | undefined; 'target-type'?: string | null | undefined; url?: { resource?: string | null | undefined } | null | undefined }>
): Array<{ type: string; url: string }> {
  const urlRels: Array<{ type: string; url: string }> = [];

  if (!relations) return urlRels;

  for (const rel of relations) {
    if (rel['target-type'] === 'url' && rel.url?.resource) {
      const type = rel.type || 'unknown';
      urlRels.push({
        type,
        url: rel.url.resource,
      });
    }
  }

  return urlRels;
}

/**
 * Extract Discogs IDs from URL relations.
 */
export function discogsIdsFromUrlRelations(
  rels?: Array<{ type: string; url: string }>
): { releaseId?: number; masterId?: number } {
  const result: { releaseId?: number; masterId?: number } = {};

  if (!rels) return result;

  for (const rel of rels) {
    if (rel.type === 'discogs') {
      // https://www.discogs.com/release/1671391 or /master/96568
      const releaseMatch = rel.url.match(/\/release\/(\d+)/);
      if (releaseMatch) {
        result.releaseId = parseInt(releaseMatch[1]!, 10);
        continue;
      }
      const masterMatch = rel.url.match(/\/master\/(\d+)/);
      if (masterMatch) {
        result.masterId = parseInt(masterMatch[1]!, 10);
      }
    }
  }

  return result;
}

/**
 * Extract Wikidata QID from URL relations.
 */
export function wikidataQidFromUrlRelations(
  rels?: Array<{ type: string; url: string }>
): string | undefined {
  if (!rels) return undefined;

  for (const rel of rels) {
    if (rel.type === 'wikidata' && rel.url && typeof rel.url === 'string') {
      // https://www.wikidata.org/wiki/Q918304 → Q918304
      const match = rel.url.match(/\/wiki\/(Q\d+)/);
      if (match) return match[1];
    }
  }

  return undefined;
}

/**
 * Convert MusicBrainz release to canonical format.
 */
function mbReleaseToCanonical(mbRelease: z.infer<typeof ReleaseSchema>): CanonicalRelease {
  const artists = formatArtistCredit(mbRelease['artist-credit']);
  const rg = mbRelease['release-group'];

  // Flatten all tracks from all media
  const tracks: CanonicalTrack[] = [];
  if (mbRelease.media) {
    for (const medium of mbRelease.media) {
      const mediumNum = parseInt(medium.position ?? '1', 10);
      if (medium.tracks) {
        for (const track of medium.tracks) {
          tracks.push(mbTrackToCanonical(track, mediumNum));
        }
      }
    }
  }

  // Extract label info
  let label: string | undefined;
  let catalogNumber: string | undefined;
  if (mbRelease['label-info'] && mbRelease['label-info'].length > 0) {
    const labelInfo = mbRelease['label-info'][0];
    if (labelInfo) {
      label = labelInfo.label?.name || undefined;
      catalogNumber = labelInfo['catalog-number'] || undefined;
    }
  }

  // Extract URL relations
  const urlRelations = extractUrlRelations(mbRelease.relations);

  // Extract artist credits with MusicBrainz IDs (spec ENR-7)
  const artistCredits = mbArtistCreditsToCanonical(mbRelease['artist-credit']);

  // Prefer release-group genres/tags, else use release's (spec ENR-3)
  const genres: WeightedTag[] | undefined = rg?.genres?.length ? rg.genres : mbRelease.genres;
  const tags: WeightedTag[] | undefined = rg?.tags?.length ? rg.tags : mbRelease.tags;

  return {
    id: mbRelease.id,
    releaseGroupId: rg?.id || mbRelease.id,
    title: mbRelease.title,
    artists: artists.length > 0 ? artists : [mbRelease.title],
    tracks,
    year: mbRelease.date ? parseInt(mbRelease.date.split('-')[0] || '0', 10) : undefined,
    date: mbRelease.date || undefined,
    country: mbRelease.country || undefined,
    barcode: mbRelease.barcode || undefined,
    catalogNumber,
    media: mbRelease.media?.[0]?.format || undefined,
    status: mbRelease.status || undefined,
    label,
    source: 'musicbrainz',
    sourceId: mbRelease.id,
    urlRelations: urlRelations.length > 0 ? urlRelations : undefined,
    artistCredits: artistCredits.length > 0 ? artistCredits : undefined,
    mbGenres: genres?.length ? genres : undefined,
    mbTags: tags?.length ? tags : undefined,
    primaryType: rg?.['primary-type'] || undefined,
    secondaryTypes: rg?.['secondary-types']?.length ? rg['secondary-types'] : undefined,
  };
}

/**
 * MusicBrainz provider implementation.
 */
export class MusicBrainzProvider implements MetadataProvider {
  id = 'musicbrainz';
  name = 'MusicBrainz';

  capabilities = new Set([
    'searchReleases',
    'getRelease',
    'getReleaseGroup',
    'getArtist',
    'getArtistReleaseGroups',
    'lookupByBarcode',
  ] as const);

  constructor(private userAgent: string) {}

  /**
   * Search for releases by query.
   */
  async searchReleases(q: ReleaseQuery, ctx: CallContext): Promise<ReleaseCandidate[]> {
    const queryParts: string[] = [];

    if (q.albumTitle) {
      queryParts.push(`release:"${q.albumTitle.replace('"', '\\"')}"`);
    }
    if (q.artistName) {
      queryParts.push(`artist:"${q.artistName.replace('"', '\\"')}"`);
    }
    if (q.barcode) {
      queryParts.push(`barcode:"${q.barcode}"`);
    }
    if (q.catalogNumber) {
      queryParts.push(`catno:"${q.catalogNumber}"`);
    }
    if (q.trackCount) {
      queryParts.push(`tracks:${q.trackCount}`);
    }

    const query = queryParts.join(' AND ');
    if (!query) {
      return [];
    }

    const url = new URL(`${MB_BASE_URL}/release`, 'https://musicbrainz.org');
    url.searchParams.set('query', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '10');
    url.searchParams.set('inc', 'recordings+artist-credits+labels');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 503) {
        throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
      }
      throw mbHttpError(`MusicBrainz search failed: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const parsed = SearchResultSchema.parse(data);

    return (parsed.releases || []).map((release) => ({
      release: mbReleaseToCanonical(release),
      source: 'mb_search',
    }));
  }

  /**
   * Get a specific release by MBID.
   */
  async getRelease(id: string, ctx: CallContext): Promise<CanonicalRelease> {
    const url = new URL(`${MB_BASE_URL}/release/${id}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'recordings+artist-credits+labels+media+release-groups+url-rels+genres+tags');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 503) {
        throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
      }
      throw mbHttpError(`Failed to fetch MusicBrainz release ${id}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const release = ReleaseSchema.parse(data);
    return mbReleaseToCanonical(release);
  }

  /**
   * Get a release group by MBID.
   */
  async getReleaseGroup(id: string, ctx: CallContext): Promise<CanonicalRelease> {
    // Fetch release group and get the first release
    const url = new URL(`${MB_BASE_URL}/release-group/${id}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'releases+recordings+artist-credits');
    url.searchParams.set('limit', '1');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz release group ${id}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const rg = ReleaseGroupSchema.parse(data);

    // For a release group, construct a synthetic canonical release
    const releaseYear = rg['first-release-date'] ? parseInt(rg['first-release-date'].split('-')[0] || '0', 10) : undefined;
    return {
      id: rg.id,
      releaseGroupId: rg.id,
      title: rg.title,
      artists: [],
      tracks: [],
      year: releaseYear,
      source: 'musicbrainz',
      sourceId: rg.id,
    };
  }

  /**
   * Get release group with artist credits, genres, and tags (spec ENR-7).
   */
  async getReleaseGroupCredits(
    mbid: string,
    ctx: CallContext
  ): Promise<{ mbid: string; title: string; artistCredits: ArtistCredit[]; mbGenres?: WeightedTag[]; mbTags?: WeightedTag[]; primaryType?: string; secondaryTypes?: string[]; firstReleaseDate?: string }> {
    const url = new URL(`${MB_BASE_URL}/release-group/${mbid}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'artist-credits+genres+tags');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 503) {
      throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz release group ${mbid}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const rg = ReleaseGroupSchema.parse(data);

    return {
      mbid: rg.id,
      title: rg.title,
      artistCredits: mbArtistCreditsToCanonical(rg['artist-credit']),
      ...(rg.genres?.length ? { mbGenres: rg.genres } : {}),
      ...(rg.tags?.length ? { mbTags: rg.tags } : {}),
      ...(rg['primary-type'] ? { primaryType: rg['primary-type'] } : {}),
      ...(rg['secondary-types']?.length ? { secondaryTypes: rg['secondary-types'] } : {}),
      ...(rg['first-release-date'] ? { firstReleaseDate: rg['first-release-date'] } : {}),
    };
  }

  /**
   * Get URL relations for a release group.
   */
  async getReleaseGroupUrlRelations(
    rgMbid: string,
    ctx: CallContext
  ): Promise<Array<{ type: string; url: string }>> {
    const url = new URL(`${MB_BASE_URL}/release-group/${rgMbid}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'url-rels');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 503) throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz release group ${rgMbid}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const rgData = z.object({
      relations: z.array(RelationSchema).optional(),
    }).parse(data);

    return extractUrlRelations(rgData.relations);
  }

  /**
   * Community rating of a release group (spec REV-1; CC BY-NC-SA 3.0).
   * value is null when nobody has voted.
   */
  async getReleaseGroupRating(
    rgMbid: string,
    _ctx: CallContext
  ): Promise<{ value: number | null; votes: number }> {
    const url = new URL(`${MB_BASE_URL}/release-group/${rgMbid}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'ratings');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 503) throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz release group ${rgMbid}: ${response.statusText}`, response.status);
    }

    const data = z.object({
      rating: z.object({
        value: z.number().nullish(),
        'votes-count': z.number().nullish(),
      }).nullish(),
    }).parse(await response.json());

    return {
      value: data.rating?.value ?? null,
      votes: data.rating?.['votes-count'] ?? 0,
    };
  }

  /**
   * Look up a URL to find related releases and release groups.
   */
  async lookupUrl(
    resource: string,
    ctx: CallContext
  ): Promise<{ releaseMbids: string[]; releaseGroupMbids: string[] }> {
    const url = new URL(`${MB_BASE_URL}/url`, 'https://musicbrainz.org');
    url.searchParams.set('resource', resource);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'release-rels+release-group-rels');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 404) {
      return { releaseMbids: [], releaseGroupMbids: [] };
    }

    if (response.status === 503) throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    if (!response.ok) {
      throw mbHttpError(`Failed to look up URL ${resource}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const urlData = z.object({
      relations: z.array(z.object({
        type: z.string().nullish(),
        'target-type': z.string().nullish(),
        release: z.object({ id: z.string() }).nullish(),
        'release-group': z.object({ id: z.string() }).nullish(),
      })).nullish(),
    }).parse(data);

    const releaseMbids: string[] = [];
    const releaseGroupMbids: string[] = [];

    if (urlData.relations) {
      for (const rel of urlData.relations) {
        if (rel['target-type'] === 'release' && rel.release?.id) {
          releaseMbids.push(rel.release.id);
        } else if (rel['target-type'] === 'release-group' && rel['release-group']?.id) {
          releaseGroupMbids.push(rel['release-group'].id);
        }
      }
    }

    return { releaseMbids, releaseGroupMbids };
  }

  /**
   * Get artist metadata with aliases and URL relations (spec ENR-7).
   */
  async getArtist(id: string, ctx: CallContext): Promise<MbArtist> {
    const url = new URL(`${MB_BASE_URL}/artist/${id}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'url-rels+aliases');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 503) {
      throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz artist ${id}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const artist = ArtistSchema.parse(data);

    // Extract unique aliases, with primary first (spec ENR-7)
    const aliasSet = new Set<string>();
    const primaryAliases: string[] = [];
    const otherAliases: string[] = [];

    if (artist.aliases) {
      for (const alias of artist.aliases) {
        const aliasName = alias.name;
        if (aliasSet.has(aliasName)) continue;
        aliasSet.add(aliasName);

        if (alias.primary) {
          primaryAliases.push(aliasName);
        } else {
          otherAliases.push(aliasName);
        }
      }
    }

    const aliases = [...primaryAliases, ...otherAliases];

    // Extract country: prefer 'country' field, else area iso-3166-1 codes
    let country: string | undefined;
    if (artist.country) {
      country = artist.country;
    } else if (artist.area?.['iso-3166-1-codes']?.length) {
      country = artist.area['iso-3166-1-codes'][0];
    }

    // Extract URL relations
    const urlRels = extractUrlRelations(artist.relations);

    return {
      id: artist.id,
      name: artist.name,
      ...(artist['sort-name'] ? { sortName: artist['sort-name'] } : {}),
      ...(artist.disambiguation ? { disambiguation: artist.disambiguation } : {}),
      ...(artist.type ? { type: artist.type } : {}),
      ...(country ? { country } : {}),
      ...(artist['begin-date'] ? { beginDate: artist['begin-date'] } : {}),
      ...(artist['end-date'] ? { endDate: artist['end-date'] } : {}),
      ...(artist.ended !== null && artist.ended !== undefined ? { ended: artist.ended } : {}),
      aliases,
      urlRelations: urlRels,
    };
  }

  /**
   * Get artist's release groups.
   */
  async getArtistReleaseGroups(
    artistId: string,
    ctx: CallContext
  ): Promise<CanonicalRelease[]> {
    const url = new URL(`${MB_BASE_URL}/artist/${artistId}/release-groups`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '100');
    url.searchParams.set('inc', 'artist-credits');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw mbHttpError(
        `Failed to fetch MusicBrainz artist release groups for ${artistId}: ${response.statusText}`, response.status
      );
    }

    const data = await response.json();
    const parsed = z
      .object({
        'release-groups': z.array(ReleaseGroupSchema).optional(),
      })
      .parse(data);

    return (parsed['release-groups'] || []).map((rg) => {
      const rgYear = rg['first-release-date'] ? parseInt(rg['first-release-date'].split('-')[0] || '0', 10) : undefined;
      return {
        id: rg.id,
        releaseGroupId: rg.id,
        title: rg.title,
        artists: [],
        tracks: [],
        year: rgYear,
        source: 'musicbrainz' as const,
        sourceId: rg.id,
      };
    });
  }

  /**
   * Get release group editions (all releases in the group without track detail).
   * Returns the release group metadata and the list of editions.
   */
  async getReleaseGroupEditions(
    rgMbid: string,
    ctx: CallContext
  ): Promise<{ releaseGroup: { mbid: string; title: string; primaryType?: string | null; secondaryTypes?: string[]; firstReleaseDate?: string | null }; editions: Edition[] }> {
    const url = new URL(`${MB_BASE_URL}/release-group/${rgMbid}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('inc', 'releases+media+labels+artist-credits');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 503) throw new Error(`MusicBrainz rate limited (503): ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`);
    if (!response.ok) {
      throw mbHttpError(`Failed to fetch MusicBrainz release group ${rgMbid}: ${response.statusText}`, response.status);
    }

    const data = await response.json();
    const rgData = ReleaseGroupWithReleasesSchema.parse(data);

    const editions: Edition[] = (rgData.releases || []).map((rel) => {
      // Build labels array from label-info
      const labels: Array<{ name: string; catalogNumber?: string | null }> = [];
      if (rel['label-info']) {
        for (const info of rel['label-info']) {
          if (info.label?.name) {
            labels.push({
              name: info.label.name,
              ...(info['catalog-number'] ? { catalogNumber: info['catalog-number'] } : {}),
            });
          }
        }
      }

      // Build media array
      const media: Array<{ position: number; format?: string | null; trackCount?: number | null }> = [];
      if (rel.media) {
        for (const m of rel.media) {
          media.push({
            position: parseInt(m.position ?? '0', 10),
            ...(m.format ? { format: m.format } : {}),
            ...(m['track-count'] ? { trackCount: m['track-count'] } : {}),
          });
        }
      }

      return {
        mbid: rel.id,
        title: rel.title,
        ...(rel.disambiguation ? { disambiguation: rel.disambiguation } : {}),
        ...(rel.status ? { status: rel.status } : {}),
        ...(rel.date ? { date: rel.date } : {}),
        ...(rel.country ? { country: rel.country } : {}),
        ...(rel.barcode ? { barcode: rel.barcode } : {}),
        ...(rel.packaging ? { packaging: rel.packaging } : {}),
        labels,
        media,
        ...(rel['track-count'] ? { trackCount: rel['track-count'] } : {}),
      };
    });

    return {
      releaseGroup: {
        mbid: rgData.id,
        title: rgData.title,
        ...(rgData['primary-type'] ? { primaryType: rgData['primary-type'] } : {}),
        ...(rgData['secondary-types'] ? { secondaryTypes: rgData['secondary-types'] } : {}),
        ...(rgData['first-release-date'] ? { firstReleaseDate: rgData['first-release-date'] } : {}),
      },
      editions,
    };
  }
}

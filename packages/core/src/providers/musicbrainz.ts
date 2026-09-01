/**
 * MusicBrainz metadata provider.
 * Implements spec §10.2.1, IDN-1, ENR-1.
 */
import { z } from 'zod';
import type {
  MetadataProvider,
  ReleaseQuery,
  ReleaseCandidate,
  CanonicalRelease,
  CanonicalTrack,
  CallContext,
} from './types.js';

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';

/**
 * Zod schemas for MusicBrainz API responses.
 */
const ArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  'sort-name': z.string().nullish(),
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

const ReleaseGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  'primary-type': z.string().nullish(),
  'secondary-types': z.array(z.string()).optional(),
  'first-release-date': z.string().nullish(),
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
        label: LabelSchema,
        'catalog-number': z.string().nullish(),
      })
    )
    .optional(),
  'artist-credit': z
    .array(
      z.object({
        artist: ArtistSchema,
        name: z.string().nullish(),
      })
    )
    .optional(),
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
        throw new Error('MusicBrainz rate limited (503)');
      }
      throw new Error(`MusicBrainz search failed: ${response.statusText}`);
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
    url.searchParams.set('inc', 'recordings+artist-credits+labels+media+release-groups');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 503) {
        throw new Error('MusicBrainz rate limited (503)');
      }
      throw new Error(`Failed to fetch MusicBrainz release ${id}: ${response.statusText}`);
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
      throw new Error(`Failed to fetch MusicBrainz release group ${id}: ${response.statusText}`);
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
   * Get artist metadata.
   */
  async getArtist(id: string, ctx: CallContext): Promise<{ id: string; name: string }> {
    const url = new URL(`${MB_BASE_URL}/artist/${id}`, 'https://musicbrainz.org');
    url.searchParams.set('fmt', 'json');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch MusicBrainz artist ${id}: ${response.statusText}`);
    }

    const data = await response.json();
    const artist = ArtistSchema.parse(data);
    return { id: artist.id, name: artist.name };
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
      throw new Error(
        `Failed to fetch MusicBrainz artist release groups for ${artistId}: ${response.statusText}`
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
}

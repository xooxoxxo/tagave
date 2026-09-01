/**
 * Discogs metadata provider.
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

const DISCOGS_BASE_URL = 'https://api.discogs.com';

/**
 * Zod schemas for Discogs API responses.
 */
const ArtistSchema = z.object({
  id: z.number(),
  name: z.string(),
  resource_url: z.string(),
});

const TrackSchema = z.object({
  position: z.string(),
  title: z.string(),
  duration: z.string().optional(),
  artists: z.array(ArtistSchema).optional(),
});

const ImageSchema = z.object({
  type: z.string(),
  uri: z.string(),
  resource_url: z.string(),
  thumb: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const LabelSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  catno: z.string().optional(),
  resource_url: z.string().optional(),
});

const ReleaseSchema = z.object({
  id: z.number(),
  title: z.string(),
  resource_url: z.string(),
  uri: z.string().optional(),
  artists: z.array(ArtistSchema).optional(),
  artists_sort: z.string().optional(),
  formats: z.array(z.object({ name: z.string(), qty: z.string() })).optional(),
  labels: z.array(LabelSchema).optional(),
  year: z.number().optional(),
  country: z.string().optional(),
  released: z.string().optional(),
  genres: z.array(z.string()).optional(),
  styles: z.array(z.string()).optional(),
  tracklist: z.array(TrackSchema).optional(),
  images: z.array(ImageSchema).optional(),
});

const MasterSchema = z.object({
  id: z.number(),
  title: z.string(),
  resource_url: z.string(),
  uri: z.string().optional(),
  artists: z.array(ArtistSchema).optional(),
  year: z.number().optional(),
  genres: z.array(z.string()).optional(),
  styles: z.array(z.string()).optional(),
  images: z.array(ImageSchema).optional(),
  main_release: z.number().optional(),
  main_release_url: z.string().optional(),
});

const SearchResultSchema = z.object({
  pagination: z
    .object({
      per_page: z.number(),
      items: z.number(),
      page: z.number(),
      urls: z.object({ last: z.string().optional() }).optional(),
    })
    .optional(),
  results: z.array(
    z.object({
      id: z.number(),
      type: z.enum(['release', 'master']),
      title: z.string(),
      resource_url: z.string(),
      uri: z.string().optional(),
      basic_information: z
        .object({
          id: z.number(),
          title: z.string(),
          year: z.number().optional(),
          resource_url: z.string().optional(),
          artists: z.array(ArtistSchema).optional(),
          labels: z.array(LabelSchema).optional(),
          formats: z.array(z.object({ name: z.string() })).optional(),
        })
        .optional(),
      year: z.number().optional(),
      genre: z.array(z.string()).optional(),
    })
  ),
});

/**
 * Parse Discogs duration string (MM:SS) to milliseconds.
 */
function parseDuration(duration?: string): number {
  if (!duration) return 0;
  const parts = duration.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 2) {
    return (parts[0]! * 60 + parts[1]!) * 1000;
  } else if (parts.length === 3) {
    return (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1000;
  }
  return 0;
}

/**
 * Extract artist names from Discogs artist array.
 */
function formatArtists(artists?: typeof ArtistSchema._type[]): string[] {
  if (!artists) return [];
  return artists.map((a) => a.name);
}

/**
 * Convert Discogs track to canonical format.
 */
function discogsTrackToCanonical(
  track: z.infer<typeof TrackSchema>,
  mediumNumber: number = 1
): CanonicalTrack {
  const artists = formatArtists(track.artists);
  const position = parseInt(track.position.split('-')[1] || track.position, 10);

  return {
    title: track.title,
    artists: artists.length > 0 ? artists : [track.title],
    duration: parseDuration(track.duration),
    position,
    mediumNumber,
  };
}

/**
 * Discogs provider implementation.
 */
export class DiscogsProvider implements MetadataProvider {
  id = 'discogs';
  name = 'Discogs';

  capabilities = new Set(['searchReleases', 'getRelease'] as const);

  constructor(
    private token: string,
    private userAgent: string
  ) {}

  /**
   * Make authenticated Discogs API request.
   */
  private async request(path: string): Promise<unknown> {
    const url = new URL(path, DISCOGS_BASE_URL);

    if (this.token) {
      url.searchParams.set('token', this.token);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new Error(
        `Discogs rate limited: ${retryAfter ? `retry after ${retryAfter}s` : 'check X-Discogs-Ratelimit headers'}`
      );
    }

    if (!response.ok) {
      throw new Error(`Discogs API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Search for releases by query.
   */
  async searchReleases(q: ReleaseQuery, ctx: CallContext): Promise<ReleaseCandidate[]> {
    const query = [q.albumTitle, q.artistName].filter(Boolean).join(' ');

    if (!query) {
      return [];
    }

    const data = await this.request(
      `/database/search?q=${encodeURIComponent(query)}&type=release&per_page=10`
    );
    const parsed = SearchResultSchema.parse(data);

    const candidates: ReleaseCandidate[] = [];
    for (const result of parsed.results) {
      if (result.type === 'release') {
        // Fetch full release data
        try {
          const release = await this.getRelease(String(result.id), ctx);
          candidates.push({
            release,
            source: 'discogs_search',
          });
        } catch {
          // Skip releases that fail to fetch
          continue;
        }
      }
    }

    return candidates;
  }

  /**
   * Get a specific release by ID.
   */
  async getRelease(id: string, ctx: CallContext): Promise<CanonicalRelease> {
    const data = await this.request(`/releases/${id}`);
    const release = ReleaseSchema.parse(data);

    const artists = formatArtists(release.artists);
    const label = release.labels?.[0]?.name || undefined;
    const catalogNumber = release.labels?.[0]?.catno || undefined;

    // Get media format
    let media: string | undefined;
    if (release.formats && release.formats.length > 0) {
      media = release.formats[0]?.name || undefined;
    }

    // Convert tracks
    const tracks: CanonicalTrack[] = [];
    if (release.tracklist) {
      for (const track of release.tracklist) {
        tracks.push(discogsTrackToCanonical(track));
      }
    }

    return {
      id: String(release.id),
      releaseGroupId: String(release.id), // Discogs doesn't have release groups; use release ID
      title: release.title,
      artists: artists.length > 0 ? artists : [release.title],
      tracks,
      year: release.year,
      date: release.released || undefined,
      country: release.country || undefined,
      barcode: undefined, // Not reliably in Discogs API
      catalogNumber,
      media,
      label,
      source: 'discogs',
      sourceId: String(release.id),
    };
  }

  /**
   * Get artist metadata (not fully supported by Discogs search API).
   */
  async getArtist(id: string, ctx: CallContext): Promise<{ id: string; name: string }> {
    const data = await this.request(`/artists/${id}`);
    const artist = ArtistSchema.parse(data);
    return { id: String(artist.id), name: artist.name };
  }

  /**
   * Get releases by an artist (limited support).
   */
  async getArtistReleaseGroups(
    artistId: string,
    ctx: CallContext
  ): Promise<CanonicalRelease[]> {
    // Discogs doesn't have a direct "release groups for artist" endpoint
    // This would require searching and filtering, which is limited
    // For now, return empty array
    return [];
  }
}

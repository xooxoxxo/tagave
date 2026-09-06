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
  DiscogsMaster,
  RateLimitInfo,
} from './types.js';

const DISCOGS_BASE_URL = 'https://api.discogs.com';

/**
 * Zod schemas for Discogs API responses.
 */
const ArtistSchema = z.object({
  id: z.number(),
  name: z.string(),
  anv: z.string().nullish(),
  join: z.string().nullish(),
  resource_url: z.string().nullish(),
});

const TrackSchema: z.ZodType<any, z.ZodTypeDef, any> = z.object({
  position: z.string(),
  type_: z.string().nullish(),
  title: z.string(),
  duration: z.string().nullish(),
  artists: z.array(ArtistSchema).nullish(),
  sub_tracks: z.array(z.lazy(() => TrackSchema)).nullish(),
});

const ImageSchema = z.object({
  type: z.string().nullish(),
  uri: z.string(),
  resource_url: z.string().nullish(),
  thumb: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

const LabelSchema = z.object({
  id: z.number().nullish(),
  name: z.string(),
  catno: z.string().nullish(),
  resource_url: z.string().nullish(),
});

const IdentifierSchema = z.object({
  type: z.string(),
  value: z.string(),
  description: z.string().nullish(),
});

const ReleaseSchema = z.object({
  id: z.number(),
  title: z.string(),
  resource_url: z.string(),
  uri: z.string().nullish(),
  artists: z.array(ArtistSchema).nullish(),
  artists_sort: z.string().nullish(),
  formats: z.array(z.object({ name: z.string(), qty: z.string().nullish() })).nullish(),
  labels: z.array(LabelSchema).nullish(),
  year: z.number().nullish(),
  country: z.string().nullish(),
  released: z.string().nullish(),
  genres: z.array(z.string()).nullish(),
  styles: z.array(z.string()).nullish(),
  tracklist: z.array(TrackSchema).nullish(),
  images: z.array(ImageSchema).nullish(),
  master_id: z.number().nullish(),
  master_url: z.string().nullish(),
  notes: z.string().nullish(),
  identifiers: z.array(IdentifierSchema).nullish(),
});

const MasterSchema = z.object({
  id: z.number(),
  title: z.string(),
  resource_url: z.string(),
  uri: z.string().nullish(),
  artists: z.array(ArtistSchema).nullish(),
  year: z.number().nullish(),
  genres: z.array(z.string()).nullish(),
  styles: z.array(z.string()).nullish(),
  images: z.array(ImageSchema).nullish(),
  main_release: z.number().nullish(),
  main_release_url: z.string().nullish(),
  most_recent_release: z.number().nullish(),
});

const SearchHitSchema = z.object({
  id: z.number(),
  type: z.enum(['release', 'master']).nullish(),
  title: z.string(),
  resource_url: z.string(),
  uri: z.string().nullish(),
  master_id: z.number().nullish(),
  // Live search payloads send year as a string ("1987"); releases send a number.
  year: z.union([z.number(), z.string()]).nullish().transform((v) => {
    if (v == null) return undefined;
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }),
  country: z.string().nullish(),
  format: z.array(z.string()).nullish(),
  label: z.array(z.string()).nullish(),
  catno: z.string().nullish(),
  barcode: z.array(z.string()).nullish(),
  genre: z.array(z.string()).nullish(),
  style: z.array(z.string()).nullish(),
  thumb: z.string().nullish(),
  cover_image: z.string().nullish(),
});

const SearchResultSchema = z.object({
  pagination: z.object({
    per_page: z.number().nullish(),
    items: z.number().nullish(),
    page: z.number().nullish(),
  }).nullish(),
  results: z.array(SearchHitSchema).nullish(),
});

/**
 * Parse Discogs duration string (MM:SS or H:MM:SS) to milliseconds.
 */
export function parseDiscogsDuration(duration?: string): number {
  if (!duration) return 0;
  const parts = duration.split(':').map((p: string) => parseInt(p, 10));
  if (parts.length === 2) {
    return (parts[0]! * 60 + parts[1]!) * 1000;
  } else if (parts.length === 3) {
    return (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1000;
  }
  return 0;
}

/**
 * Parse Discogs position string to {medium, position}.
 * Rules:
 * - Bare number "7" → medium 1 pos 7
 * - "1-3"/"2-03"/"CD1-3" → medium from leading number (or CD number, A,B→1, C,D→2, E,F→3)
 * - Side letters "A1"/"B2" → medium = ceil(sideIndex/2), position = numeric suffix
 * - AA/AB/BA/BB → handled as double-A side (medium 1)
 */
export function parseDiscogsPosition(position: string): { medium: number; position: number } {
  const result: { medium: number; position: number } = { medium: 1, position: 0 };
  if (!position) return { medium: 1, position: 0 };

  // Handle CD/format prefix: "CD1-3" → medium 1, or "CD2-3" → medium 2
  // The CD prefix can include a medium number: "CD1", "CD2" etc.
  const cdMatch = position.match(/^(CD|LP|VINYL)(\d+)[-.]?(.*)$/i);
  if (cdMatch && cdMatch[2]) {
    const medium = parseInt(cdMatch[2]!);
    const rest = cdMatch[3];
    if (!rest) return { medium, position: 0 };
    position = rest; // Parse the rest as a position number
  }

  // Handle side letters: "A1", "B2", "AA1", "AA2", "AB1", "BA1", "BB1"
  const sideMatch = position.match(/^([A-Z]{1,2})(\d+)?$/i);
  if (sideMatch) {
    const side = sideMatch[1]!.toUpperCase();
    const num = sideMatch[2] ? parseInt(sideMatch[2]) : 0;

    // Map letter to side index: A=0, B=1, C=2, D=3, E=4, F=5
    // Then to medium: A,B→1; C,D→2; E,F→3
    let sideIndex = 0;
    for (const char of side) {
      sideIndex = sideIndex * 26 + (char.charCodeAt(0) - 'A'.charCodeAt(0));
    }
    // For AA, AB, BA, BB: treat as medium 1
    const medium = side.length > 1 ? 1 : Math.ceil((sideIndex + 1) / 2);
    return { medium, position: num };
  }

  // Handle numeric patterns: "1", "1-3", "2-03", "1.1", "1-1"
  const numMatch = position.match(/^(\d+)(?:[-.](\d+))?$/);
  if (numMatch) {
    const first = parseInt(numMatch[1]!);
    const second = numMatch[2] ? parseInt(numMatch[2]) : undefined;

    if (second !== undefined) {
      // "1-3" or "2-03" → medium is first, position is second
      return { medium: first, position: second };
    } else {
      // Bare number → medium 1, position is the number
      return { medium: 1, position: first };
    }
  }

  // Fallback
  const num = parseInt(position, 10);
  return { medium: 1, position: isNaN(num) ? 0 : num };
}

/**
 * Normalize country code string to ISO-2.
 */
export function discogsCountryToIso(country?: string | null): string | null {
  if (!country) return null;

  const upper = country.toUpperCase().trim();

  // Direct two-letter codes
  if (upper.length === 2) {
    // Special cases
    if (upper === 'UK') return 'GB';
    return upper;
  }

  // Known exceptions
  if (upper === 'USA' || upper === 'US') return 'US';
  if (upper === 'UK' || upper === 'UNITED KINGDOM') return 'GB';
  if (upper.includes('UNKNOWN')) return null;
  if (upper.includes('WORLDWIDE') || upper.includes('WORLD')) return 'XW';
  if (upper === 'USA & CANADA' || upper === 'CANADA & USA') return 'US';

  // Europe regions
  if (upper.includes('EUROPE') || upper === 'UK & EUROPE') return 'XE';
  if (upper === 'SCANDINAVIA') return 'XE';

  // Common full country names
  const countryMap: Record<string, string> = {
    'GERMANY': 'DE',
    'FRANCE': 'FR',
    'SWEDEN': 'SE',
    'NETHERLANDS': 'NL',
    'JAPAN': 'JP',
    'ITALY': 'IT',
    'SPAIN': 'ES',
    'CANADA': 'CA',
    'AUSTRALIA': 'AU',
    'BELGIUM': 'BE',
    'DENMARK': 'DK',
    'NORWAY': 'NO',
    'FINLAND': 'FI',
    'SWITZERLAND': 'CH',
    'AUSTRIA': 'AT',
    'PORTUGAL': 'PT',
    'BRAZIL': 'BR',
    'MEXICO': 'MX',
    'POLAND': 'PL',
    'TURKEY': 'TR',
    'RUSSIA': 'RU',
    'GREECE': 'GR',
    'IRELAND': 'IE',
    'NEW ZEALAND': 'NZ',
    'ARGENTINA': 'AR',
    'CZECH REPUBLIC': 'CZ',
    'HUNGARY': 'HU',
    'ISRAEL': 'IL',
    'SOUTH AFRICA': 'ZA',
    'ICELAND': 'IS',
  };

  if (countryMap[upper]) return countryMap[upper];

  return null;
}

/**
 * Extract barcode from identifiers.
 */
export function discogsBarcodeFromIdentifiers(identifiers?: Array<{ type: string; value: string }> | null): string | undefined {
  if (!identifiers) return undefined;

  for (const id of identifiers) {
    if (id.type === 'Barcode') {
      // Keep only digits
      const digits = id.value.replace(/\D/g, '');
      if (digits) return digits;
    }
  }

  return undefined;
}

/**
 * Extract barcodes from search hit barcode array.
 */
export function discogsBarcodesFromSearchHit(barcodes?: string[] | null): string[] {
  if (!barcodes) return [];

  return barcodes
    .map(bc => bc.replace(/\D/g, ''))
    .filter(bc => bc.length >= 8);
}

/**
 * Map raw Discogs release to CanonicalRelease.
 */
export function mapDiscogsRelease(raw: z.infer<typeof ReleaseSchema>): CanonicalRelease {
  // Artist names: use anv when present, else name; strip disambiguation suffix like " (2)"
  const artistNames = (raw.artists || []).map((a: typeof ArtistSchema._type) => {
    let name = a.anv || a.name;
    name = name.replace(/\s+\(\d+\)$/, '');
    return name;
  });

  // Parse tracklist: skip heading/index rows, flatten sub_tracks
  const tracks: CanonicalTrack[] = [];
  const tracksByMedium: Record<number, CanonicalTrack[]> = {};

  if (raw.tracklist) {
    for (const track of raw.tracklist) {
      // Skip heading and index rows
      if (track.type_ === 'heading' || track.type_ === 'index') {
        // But flatten their sub_tracks
        if (track.sub_tracks) {
          for (const sub of track.sub_tracks) {
            const parsed = parseDiscogsPosition(sub.position || '1');
            if (!tracksByMedium[parsed.medium]) {
              tracksByMedium[parsed.medium] = [];
            }
            const trackArtists = (sub.artists || []).map((a: typeof ArtistSchema._type) => a.anv || a.name);
            tracksByMedium[parsed.medium]!.push({
              title: sub.title,
              artists: trackArtists.length > 0 ? trackArtists : [sub.title],
              duration: parseDiscogsDuration(sub.duration),
              position: 0, // Will be renumbered
              mediumNumber: parsed.medium,
            });
          }
        }
        continue;
      }

      const parsed = parseDiscogsPosition(track.position || '1');
      if (!tracksByMedium[parsed.medium]) {
        tracksByMedium[parsed.medium] = [];
      }

      const trackArtists = (track.artists || []).map((a: typeof ArtistSchema._type) => a.anv || a.name);

      // If has sub_tracks, use parent duration, otherwise sub_tracks contribute
      if (track.sub_tracks && track.sub_tracks.length > 0 && !track.duration) {
        for (const sub of track.sub_tracks) {
          const subParsed = parseDiscogsPosition(sub.position || '1');
          const subArtists = (sub.artists || []).map((a: typeof ArtistSchema._type) => a.anv || a.name);
          tracksByMedium[subParsed.medium] = tracksByMedium[subParsed.medium] || [];
          tracksByMedium[subParsed.medium]!.push({
            title: sub.title,
            artists: subArtists.length > 0 ? subArtists : [sub.title],
            duration: parseDiscogsDuration(sub.duration),
            position: 0, // Will be renumbered
            mediumNumber: subParsed.medium,
          });
        }
      } else {
        tracksByMedium[parsed.medium]!.push({
          title: track.title,
          artists: trackArtists.length > 0 ? trackArtists : [track.title],
          duration: parseDiscogsDuration(track.duration),
          position: 0, // Will be renumbered
          mediumNumber: parsed.medium,
        });
      }
    }
  }

  // Renumber positions to be contiguous per medium
  const orderedMediums = Object.keys(tracksByMedium).map(Number).sort((a, b) => a - b);
  for (const medium of orderedMediums) {
    tracksByMedium[medium]!.forEach((track, idx) => {
      track.position = idx + 1;
      tracks.push(track);
    });
  }

  // Media and mediaList
  let media: string | undefined;
  const mediaList: Array<{ position: number; format: string; trackCount: number }> = [];
  if (raw.formats && raw.formats.length > 0) {
    media = raw.formats[0]?.name;
    raw.formats.forEach((fmt, idx) => {
      const qty = fmt.qty ? parseInt(fmt.qty) : 1;
      mediaList.push({
        position: idx + 1,
        format: fmt.name,
        trackCount: qty,
      });
    });
  }

  // Labels
  const labels: Array<{ name: string; catalogNumber?: string }> = [];
  let label: string | undefined;
  let catalogNumber: string | undefined;
  if (raw.labels && raw.labels.length > 0) {
    label = raw.labels[0]?.name;
    catalogNumber = raw.labels[0]?.catno ?? undefined;
    raw.labels.forEach((lbl) => {
      labels.push({
        name: lbl.name,
        ...(lbl.catno ? { catalogNumber: lbl.catno } : {}),
      });
    });
  }

  // Barcode
  const barcode = discogsBarcodeFromIdentifiers(raw.identifiers);

  // Date normalization: "1999-03-00" → "1999-03", "2000" → year 2000
  let date: string | undefined;
  let year = raw.year;
  if (raw.released) {
    if (raw.released.includes('-00')) {
      // Strip 00 parts
      date = raw.released.replace(/-00$/, '').replace(/-00-/, '-');
      if (date.includes('-00')) {
        date = date.split('-').filter(p => p !== '00').join('-');
      }
    } else {
      date = raw.released;
    }
    if (!year && date) {
      year = parseInt(date.split('-')[0]!, 10);
    }
  }

  // Country
  const country = discogsCountryToIso(raw.country);

  // Images
  const images = (raw.images || []).map((img: typeof ImageSchema._type) => ({
    url: img.uri,
    ...(img.width != null ? { width: img.width } : {}),
    ...(img.height != null ? { height: img.height } : {}),
    primary: img.type === 'primary',
  }));

  // Release group ID: master_id if present, else release:<id>
  let releaseGroupId: string;
  if (raw.master_id && raw.master_id > 0) {
    releaseGroupId = String(raw.master_id);
  } else {
    releaseGroupId = `release:${raw.id}`;
  }

  return {
    id: String(raw.id),
    releaseGroupId,
    title: raw.title,
    artists: artistNames.length > 0 ? artistNames : [raw.title],
    tracks,
    ...(year ? { year } : {}),
    ...(date ? { date } : {}),
    ...(country ? { country } : {}),
    ...(barcode ? { barcode } : {}),
    ...(catalogNumber ? { catalogNumber } : {}),
    ...(media ? { media } : {}),
    ...(label ? { label } : {}),
    source: 'discogs',
    sourceId: String(raw.id),
    ...(raw.master_id && raw.master_id > 0 ? { discogsMasterId: String(raw.master_id) } : {}),
    ...(raw.genres ? { genres: raw.genres } : {}),
    ...(raw.styles ? { styles: raw.styles } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(mediaList.length > 0 ? { mediaList } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

/**
 * Map search hit to CanonicalRelease (without full data).
 */
export function mapDiscogsSearchHit(hit: z.infer<typeof SearchHitSchema>): CanonicalRelease {
  // Title is "Artist - Title": split on first " - "
  let artists: string[] = [];
  let title = hit.title;
  const dashIdx = hit.title.indexOf(' - ');
  if (dashIdx > 0) {
    artists = [hit.title.substring(0, dashIdx).replace(/\s+\(\d+\)$/, '')];
    title = hit.title.substring(dashIdx + 3);
  }

  // Get format from format array
  let media: string | undefined;
  if (hit.format && hit.format.length > 0) {
    media = hit.format[0];
  }

  // Barcodes
  const barcodes = discogsBarcodesFromSearchHit(hit.barcode);
  const barcode = barcodes[0];

  // Labels
  const labels: Array<{ name: string; catalogNumber?: string }> = [];
  let label: string | undefined;
  if (hit.label && hit.label.length > 0) {
    label = hit.label[0];
    if (label) {
      labels.push({
        name: label,
        ...(hit.catno ? { catalogNumber: hit.catno } : {}),
      });
    }
  }

  // Country
  const country = discogsCountryToIso(hit.country);

  // Release group ID
  let releaseGroupId: string;
  if (hit.master_id && hit.master_id > 0) {
    releaseGroupId = String(hit.master_id);
  } else {
    releaseGroupId = `release:${hit.id}`;
  }

  return {
    id: String(hit.id),
    releaseGroupId,
    title,
    artists,
    tracks: [],
    ...(hit.year ? { year: hit.year } : {}),
    ...(country ? { country } : {}),
    ...(barcode ? { barcode } : {}),
    ...(hit.catno ? { catalogNumber: hit.catno } : {}),
    ...(media ? { media } : {}),
    ...(label ? { label } : {}),
    source: 'discogs',
    sourceId: String(hit.id),
    ...(hit.master_id && hit.master_id > 0 ? { discogsMasterId: String(hit.master_id) } : {}),
    ...(hit.genre ? { genres: hit.genre } : {}),
    ...(hit.style ? { styles: hit.style } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

/**
 * Parse Discogs reference (URL, ID, etc).
 * Accepts:
 * - https://www.discogs.com/release/123-Artist-Title
 * - https://www.discogs.com/de/release/123  (with locale)
 * - /master/456
 * - discogs.com/release/123
 * - [r123], [m456]
 * - r123, m456
 * - release/123, master/456
 * - bare digits (→ release)
 */
export function parseDiscogsRef(input: string): { kind: 'release' | 'master'; id: number } | null {
  if (!input) return null;

  const lower = input.toLowerCase().trim();

  // [r123], [m456]
  const bracketMatch = lower.match(/^\[([rm])(\d+)\]$/);
  if (bracketMatch) {
    const kind = bracketMatch[1] === 'r' ? 'release' : 'master';
    const id = parseInt(bracketMatch[2]!, 10);
    return { kind, id };
  }

  // r123, m456
  const prefixMatch = lower.match(/^([rm])(\d+)$/);
  if (prefixMatch) {
    const kind = prefixMatch[1] === 'r' ? 'release' : 'master';
    const id = parseInt(prefixMatch[2]!, 10);
    return { kind, id };
  }

  // release/123, master/456 or /release/123, /master/456
  const slashMatch = lower.match(/\/(release|master)\/(\d+)/);
  if (slashMatch) {
    const kind = slashMatch[1] === 'release' ? 'release' : 'master';
    const id = parseInt(slashMatch[2]!, 10);
    return { kind, id };
  }

  // Full URL: https://www.discogs.com(/locale)?/(release|master)/123(-slug)?
  const urlMatch = lower.match(
    /https?:\/\/(?:www\.)?discogs\.com(?:\/[a-z]{2})?\/(?:release|master)\/(\d+)/
  );
  if (urlMatch) {
    const urlKindMatch = lower.match(/\/(?:release|master)\/\d+/);
    const kind = urlKindMatch && urlKindMatch[0].includes('master') ? 'master' : 'release';
    const id = parseInt(urlMatch[1]!, 10);
    return { kind, id };
  }

  // Bare digits
  const bareMatch = lower.match(/^(\d+)$/);
  if (bareMatch) {
    const id = parseInt(bareMatch[1]!, 10);
    return { kind: 'release', id };
  }

  return null;
}

/**
 * Discogs provider implementation.
 */
export class DiscogsProvider implements MetadataProvider {
  id = 'discogs';
  name = 'Discogs';

  capabilities = new Set(['searchReleases', 'getRelease'] as const);

  private fetchImpl: typeof fetch;
  private token: string | undefined;
  private userAgent: string;
  lastRateLimit?: RateLimitInfo;

  constructor(options: {
    token?: string;
    userAgent: string;
    fetchImpl?: typeof fetch;
  }) {
    this.token = options.token;
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  get authenticated(): boolean {
    return !!this.token;
  }

  /**
   * Make authenticated Discogs API request.
   */
  private async request(path: string): Promise<unknown> {
    const url = new URL(path, DISCOGS_BASE_URL);

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
    // Header auth only (spec Appendix C); a query-string token would leak
    // into logs and cache keys.
    if (this.token) headers['Authorization'] = `Discogs token=${this.token}`;
    const response = await this.fetchImpl(url.toString(), { headers });

    // Capture rate limit headers
    const limit = response.headers.get('X-Discogs-Ratelimit');
    const used = response.headers.get('X-Discogs-Ratelimit-Used');
    const remaining = response.headers.get('X-Discogs-Ratelimit-Remaining');
    if (limit && used && remaining) {
      this.lastRateLimit = {
        limit: parseInt(limit, 10),
        used: parseInt(used, 10),
        remaining: parseInt(remaining, 10),
      };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
      const err = new Error(`Discogs rate limited (429): ${retryAfter ? `retry after ${retryAfter}s` : 'unknown'}`);
      (err as any).retryAfterMs = retryAfterMs;
      throw err;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Discogs token required or invalid');
    }

    if (response.status === 404) {
      const err = new Error(`Discogs not found (404): ${path}`);
      (err as any).status = 404;
      throw err;
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
    const params = new URLSearchParams();
    params.set('type', 'release');
    params.set('per_page', '10');

    if (q.artistName) params.set('artist', q.artistName);
    if (q.albumTitle) params.set('release_title', q.albumTitle);
    if (q.barcode) params.set('barcode', q.barcode);
    if (q.catalogNumber) params.set('catno', q.catalogNumber);
    if (q.year) params.set('year', String(q.year));

    const path = `/database/search?${params.toString()}`;
    const data = await this.request(path);
    const parsed = SearchResultSchema.parse(data);

    let hits = parsed.results || [];

    // Fallback to free text search if artist+title given but no results
    if (hits.length === 0 && q.artistName && q.albumTitle) {
      const fallbackQ = `${q.artistName} ${q.albumTitle}`;
      const fallbackParams = new URLSearchParams();
      fallbackParams.set('type', 'release');
      fallbackParams.set('q', fallbackQ);
      fallbackParams.set('per_page', '10');
      const fallbackPath = `/database/search?${fallbackParams.toString()}`;
      const fallbackData = await this.request(fallbackPath);
      const fallbackParsed = SearchResultSchema.parse(fallbackData);
      hits = fallbackParsed.results || [];
    }

    // Map search hits directly (no full fetch)
    return hits
      .filter(hit => hit.type === 'release' || !hit.type)
      .map(hit => ({
        release: mapDiscogsSearchHit(hit),
        source: 'discogs_search' as const,
      }));
  }

  /**
   * Get a specific release by ID.
   */
  async getRelease(id: string, ctx: CallContext): Promise<CanonicalRelease> {
    const data = await this.request(`/releases/${id}`);
    const release = ReleaseSchema.parse(data);
    return mapDiscogsRelease(release);
  }

  /**
   * Get raw parsed release (for caching).
   */
  async getRawRelease(id: string, ctx: CallContext): Promise<z.infer<typeof ReleaseSchema>> {
    const data = await this.request(`/releases/${id}`);
    return ReleaseSchema.parse(data);
  }

  /**
   * Get a master release.
   */
  async getMaster(id: string, ctx: CallContext): Promise<DiscogsMaster> {
    const data = await this.request(`/masters/${id}`);
    const master = MasterSchema.parse(data);

    const artists = (master.artists || []).map((a: typeof ArtistSchema._type) => {
      let name = a.anv || a.name;
      name = name.replace(/\s+\(\d+\)$/, '');
      return name;
    });

    const images = (master.images || []).map((img) => ({
      url: img.uri,
      ...(img.width != null ? { width: img.width } : {}),
      ...(img.height != null ? { height: img.height } : {}),
      primary: img.type === 'primary',
    }));

    return {
      id: master.id,
      title: master.title,
      ...(master.year != null ? { year: master.year } : {}),
      ...(master.main_release != null ? { mainReleaseId: master.main_release } : {}),
      artists,
      ...(master.genres ? { genres: master.genres } : {}),
      ...(master.styles ? { styles: master.styles } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  }

  /**
   * Get authenticated user identity (spec COL-1).
   */
  async getIdentity(ctx: CallContext): Promise<{ username: string; id: number }> {
    const data = await this.request('/oauth/identity');
    const identity = z.object({ username: z.string(), id: z.number() }).parse(data);
    return identity;
  }

  /**
   * List user's collection folders (spec COL-1).
   */
  async listCollectionFolders(username: string, ctx: CallContext): Promise<Array<{ id: number; name: string; count: number }>> {
    const data = await this.request(`/users/${username}/collection/folders`);
    const parsed = z.object({
      folders: z.array(z.object({
        id: z.number(),
        name: z.string(),
        count: z.number().nullish(),
      }).nullish()).nullish(),
    }).parse(data);
    return (parsed.folders || []).filter((f): f is typeof f & { id: number } => f != null).map(f => ({
      id: f.id,
      name: f.name,
      count: f.count ?? 0,
    }));
  }

  /**
   * Get custom fields for collection (spec COL-1).
   * Returns empty array if none exist (404/403).
   */
  async getCollectionFields(username: string, ctx: CallContext): Promise<Array<{ id: number; name: string; type: string }>> {
    try {
      const data = await this.request(`/users/${username}/collection/fields`);
      const parsed = z.object({
        fields: z.array(z.object({
          id: z.number(),
          name: z.string(),
          type: z.string(),
        }).nullish()).nullish(),
      }).parse(data);
      return (parsed.fields || []).filter((f): f is typeof f & { id: number } => f != null);
    } catch (e: any) {
      // 404/403 when user has no custom fields
      if (e.status === 404 || e.status === 403) {
        return [];
      }
      throw e;
    }
  }

  /**
   * List collection page for a folder (spec COL-1).
   * Per spec: folder 0 = "All", paginated at per_page items per page.
   */
  async listCollectionPage(
    username: string,
    folderId: number,
    page: number,
    ctx: CallContext,
    perPage: number = 100
  ): Promise<{ page: number; pages: number; items: DiscogsCollectionItem[] }> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('per_page', String(perPage));
    params.set('sort', 'added');
    params.set('sort_order', 'desc');

    const data = await this.request(`/users/${username}/collection/folders/${folderId}/releases?${params.toString()}`);
    const CollectionReleaseSchema = z.object({
      id: z.number(),
      instance_id: z.number(),
      folder_id: z.number().nullish(),
      date_added: z.string().nullish(),
      rating: z.number().nullish(),
      basic_information: z.object({
        id: z.number(),
        master_id: z.number().nullish(),
        master_url: z.string().nullish(),
        title: z.string(),
        year: z.number().nullish(),
        artists: z.array(ArtistSchema).nullish(),
        labels: z.array(LabelSchema).nullish(),
        formats: z.array(z.object({
          name: z.string(),
          qty: z.string().nullish(),
          descriptions: z.array(z.string()).nullish(),
        })).nullish(),
        genres: z.array(z.string()).nullish(),
        styles: z.array(z.string()).nullish(),
        thumb: z.string().nullish(),
        cover_image: z.string().nullish(),
      }).nullish(),
      notes: z.array(z.object({
        field_id: z.number(),
        value: z.string(),
      })).nullish(),
    });

    const parsed = z.object({
      pagination: z.object({
        page: z.number().nullish(),
        pages: z.number().nullish(),
        per_page: z.number().nullish(),
        items: z.number().nullish(),
      }).nullish(),
      releases: z.array(CollectionReleaseSchema).nullish(),
    }).parse(data);

    const items = (parsed.releases || []).map((r) => mapCollectionRelease(r, parsed.pagination?.items ?? 0));

    return {
      page: parsed.pagination?.page ?? page,
      pages: parsed.pagination?.pages ?? 1,
      items,
    };
  }
}

/**
 * Mapped Discogs collection item (spec COL-1).
 */
export interface DiscogsCollectionItem {
  instanceId: number;
  releaseId: number;
  masterId?: number;
  folderId: number;
  dateAdded: string;
  rating?: number;
  title: string;
  artists: string[];
  year?: number;
  labels: Array<{ name: string; catalogNumber?: string }>;
  formats: Array<{ name: string; qty?: number; descriptions: string[] }>;
  genres: string[];
  styles: string[];
  thumbUrl?: string;
  coverUrl?: string;
  notes: Array<{ fieldId: number; value: string }>;
}

/**
 * Map raw Discogs collection release to DiscogsCollectionItem (spec COL-1).
 */
export function mapCollectionRelease(raw: any, _totalItems: number): DiscogsCollectionItem {
  const bi = raw.basic_information || {};
  const artists = (bi.artists || []).map((a: any) => {
    let name = a.anv || a.name;
    // Remove disambiguation suffix like " (2)"
    name = name.replace(/\s+\(\d+\)$/, '');
    return name;
  });

  const labels = (bi.labels || []).map((l: any) => ({
    name: l.name,
    ...(l.catno ? { catalogNumber: l.catno } : {}),
  }));

  const formats = (bi.formats || []).map((f: any) => ({
    name: f.name,
    ...(f.qty ? { qty: parseInt(f.qty, 10) } : {}),
    descriptions: f.descriptions || [],
  }));

  return {
    instanceId: raw.instance_id,
    releaseId: raw.id,
    ...(bi.master_id && bi.master_id > 0 ? { masterId: bi.master_id } : {}),
    folderId: raw.folder_id ?? 0,
    dateAdded: raw.date_added || new Date().toISOString(),
    ...(raw.rating ? { rating: raw.rating } : {}),
    title: bi.title || '',
    artists,
    ...(bi.year ? { year: bi.year } : {}),
    labels,
    formats,
    genres: bi.genres || [],
    styles: bi.styles || [],
    ...(bi.thumb ? { thumbUrl: bi.thumb } : {}),
    ...(bi.cover_image ? { coverUrl: bi.cover_image } : {}),
    notes: (raw.notes || []).map((n: any) => ({
      fieldId: n.field_id,
      value: n.value,
    })),
  };
}

/**
 * Extract media/sleeve condition and notes from custom fields (spec COL-1).
 * Fields matched case-insensitively by name.
 */
export function conditionsFromNotes(
  notes: Array<{ fieldId: number; value: string }>,
  fields: Array<{ id: number; name: string }>
): { mediaCondition?: string; sleeveCondition?: string; notes?: string } {
  const result: { mediaCondition?: string; sleeveCondition?: string; notes?: string } = {};

  // Build map of field id → name
  const fieldMap = new Map(fields.map(f => [f.id, f.name.toLowerCase()]));

  for (const note of notes) {
    const fieldName = fieldMap.get(note.fieldId)?.toLowerCase() || '';
    if (fieldName.includes('media condition') || fieldName === 'media condition') {
      result.mediaCondition = note.value;
    } else if (fieldName.includes('sleeve condition') || fieldName === 'sleeve condition') {
      result.sleeveCondition = note.value;
    } else if (fieldName === 'notes') {
      result.notes = note.value;
    }
  }

  return result;
}

/**
 * A small client for Lidarr's API v1 (the lidarr module; vault "tagave - Get
 * Missing Albums"). Only what Get needs, each call checked against Lidarr's
 * own controllers (src/Lidarr.Api.V1):
 *
 *   GET  /api/v1/system/status                 version (Test)
 *   GET  /api/v1/rootfolder                    root folders (Test, settings)
 *   GET  /api/v1/qualityprofile                quality profiles
 *   GET  /api/v1/metadataprofile               metadata profiles
 *   GET  /api/v1/artist?mbId=<uuid>            the artist by MusicBrainz id ([] or [artist])
 *   GET  /api/v1/album?foreignAlbumId=<uuid>   the album by release-group MBID ([] or [album])
 *   GET  /api/v1/album?albumIds=1&albumIds=2   albums with their statistics (poll)
 *   POST /api/v1/album                         add one album (and its artist when new)
 *   PUT  /api/v1/album/monitor                 { albumIds, monitored }
 *   POST /api/v1/command                       { name: 'AlbumSearch', albumIds }
 *   GET  /api/v1/queue?page=1&pageSize=…       what is downloading
 *   GET  /api/v1/trackfile?albumId=<id>        where an album's files landed
 *
 * The key travels in the X-Api-Key header and nowhere else: never in a URL,
 * a log line or an error message. Every call has a timeout, refuses a
 * redirect (fetch would carry the header to the next host), reads at most
 * MAX_BODY bytes and is parsed with zod; fields tagave does not use are
 * dropped and text is length-capped. A failure is one of a few fixed
 * messages (LIDARR_ERRORS): nothing the other end sent (its status text,
 * headers, body or HTML) is ever put into an error, so an address that is
 * not Lidarr cannot be read through tagave.
 */
import { z } from 'zod';

export const LIDARR_TIMEOUT_MS = 10_000;
/** The largest answer read: a queue page or an album with its releases fits easily. */
export const MAX_BODY = 2 * 1024 * 1024;

/** The only words a Lidarr failure is ever told in. */
export const LIDARR_ERRORS = {
  unreachable: "Can't reach",
  notLidarr: 'Not Lidarr',
  key: 'Wrong API key',
  timeout: 'Timed out',
  /** Lidarr answered, but refused what was asked (a 4xx or 5xx other than the key) */
  refused: 'Lidarr refused it',
  /** an address the owner typed that is not one */
  address: 'Not an address',
} as const;
export type LidarrErrorCode = keyof typeof LIDARR_ERRORS;

export class LidarrError extends Error {
  constructor(readonly code: LidarrErrorCode, readonly status: number | null = null) {
    super(LIDARR_ERRORS[code]);
    this.name = 'LidarrError';
  }
}

/**
 * The address as tagave stores it: http(s) only, no user or password in it,
 * no query or fragment, no trailing slash. Lidarr behind a reverse proxy
 * under a path (https://example.com/lidarr) keeps the path. Throws a
 * LidarrError for anything else.
 */
export function normalizeLidarrUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new LidarrError('address');
  }
  // http(s) only, no user or password, no query: anything else is not an address of a Lidarr
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) throw new LidarrError('address');
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const text = (max: number) => z.string().max(max * 4).transform((s) => s.slice(0, max));
const id = z.number().int().nonnegative();

export const lidarrStatusSchema = z.object({ version: text(40) });
export const lidarrRootFolderSchema = z.object({ id, path: text(1024), name: text(200).nullish(), accessible: z.boolean().optional() });
export const lidarrProfileSchema = z.object({ id, name: text(200) });
export const lidarrArtistSchema = z.object({
  id,
  foreignArtistId: text(64),
  artistName: text(500).nullish(),
  path: text(2048).nullish(),
  qualityProfileId: id.optional(),
  metadataProfileId: id.optional(),
});
export const lidarrAlbumSchema = z.object({
  id,
  foreignAlbumId: text(64),
  title: text(500).nullish(),
  monitored: z.boolean(),
  artistId: id.optional(),
  lastSearchTime: z.string().max(64).nullish(),
  statistics: z.object({
    trackFileCount: z.number().int().nonnegative(),
    trackCount: z.number().int().nonnegative(),
    totalTrackCount: z.number().int().nonnegative().optional(),
  }).nullish(),
});
export const lidarrQueueItemSchema = z.object({
  id: z.number().int(),
  albumId: id.nullish(),
  size: z.number().nonnegative().nullish(),
  sizeleft: z.number().nonnegative().nullish(),
  status: text(40).nullish(),
  trackedDownloadState: text(40).nullish(),
});
export const lidarrQueuePageSchema = z.object({ totalRecords: z.number().int().nonnegative(), records: z.array(lidarrQueueItemSchema).max(1000) });
export const lidarrTrackFileSchema = z.object({ id, path: text(4096), albumId: id.optional() });
export const lidarrCommandSchema = z.object({ id, name: text(100).nullish() });

export type LidarrRootFolder = z.infer<typeof lidarrRootFolderSchema>;
export type LidarrProfile = z.infer<typeof lidarrProfileSchema>;
export type LidarrArtist = z.infer<typeof lidarrArtistSchema>;
export type LidarrAlbum = z.infer<typeof lidarrAlbumSchema>;
export type LidarrQueueItem = z.infer<typeof lidarrQueueItemSchema>;

/** What a connection is: the address and the key, opened. */
export interface LidarrServer {
  url: string;
  apiKey: string;
}

export interface LidarrClientOptions {
  timeoutMs?: number;
  /** tests pass their own */
  fetch?: typeof fetch;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new LidarrError('notLidarr');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class LidarrClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly server: LidarrServer, opts: LidarrClientOptions = {}) {
    this.base = normalizeLidarrUrl(server.url);
    this.timeoutMs = opts.timeoutMs ?? LIDARR_TIMEOUT_MS;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/api/v1${path}`, {
        method,
        headers: { 'X-Api-Key': this.server.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new LidarrError('timeout');
      throw new LidarrError('unreachable');
    }
    // a redirect is not followed (it would carry the key elsewhere): not a Lidarr tagave talks to
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new LidarrError('notLidarr', res.status);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new LidarrError('key', res.status);
    }
    let raw: string;
    try {
      raw = await readCapped(res);
    } catch (err) {
      if (err instanceof LidarrError) throw err;
      const name = (err as Error).name;
      throw new LidarrError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable');
    }
    if (!res.ok) throw new LidarrError(res.status === 404 ? 'notLidarr' : 'refused', res.status);
    let json: unknown;
    try {
      json = raw === '' ? null : JSON.parse(raw);
    } catch {
      throw new LidarrError('notLidarr');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new LidarrError('notLidarr');
    return parsed.data;
  }

  status() { return this.call('GET', '/system/status', lidarrStatusSchema); }
  rootFolders() { return this.call('GET', '/rootfolder', z.array(lidarrRootFolderSchema).max(200)); }
  qualityProfiles() { return this.call('GET', '/qualityprofile', z.array(lidarrProfileSchema).max(500)); }
  metadataProfiles() { return this.call('GET', '/metadataprofile', z.array(lidarrProfileSchema).max(500)); }

  async artistByMbid(mbid: string): Promise<LidarrArtist | null> {
    const list = await this.call('GET', `/artist?mbId=${encodeURIComponent(mbid)}`, z.array(lidarrArtistSchema).max(10));
    return list.find((a) => a.foreignArtistId === mbid) ?? list[0] ?? null;
  }

  async albumByMbid(mbid: string): Promise<LidarrAlbum | null> {
    const list = await this.call('GET', `/album?foreignAlbumId=${encodeURIComponent(mbid)}`, z.array(lidarrAlbumSchema).max(50));
    return list.find((a) => a.foreignAlbumId === mbid) ?? null;
  }

  albumsById(ids: readonly number[]): Promise<LidarrAlbum[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const q = ids.map((i) => `albumIds=${i}`).join('&');
    return this.call('GET', `/album?${q}`, z.array(lidarrAlbumSchema).max(ids.length + 10));
  }

  addAlbum(input: unknown): Promise<LidarrAlbum> {
    return this.call('POST', '/album', lidarrAlbumSchema, input);
  }

  async setMonitored(albumIds: readonly number[], monitored: boolean): Promise<void> {
    await this.call('PUT', '/album/monitor', z.unknown(), { albumIds, monitored });
  }

  async searchAlbums(albumIds: readonly number[]): Promise<void> {
    await this.call('POST', '/command', lidarrCommandSchema, { name: 'AlbumSearch', albumIds });
  }

  queue(pageSize = 200) {
    return this.call('GET', `/queue?page=1&pageSize=${pageSize}&includeUnknownArtistItems=false`, lidarrQueuePageSchema);
  }

  trackFiles(albumId: number) {
    return this.call('GET', `/trackfile?albumId=${albumId}`, z.array(lidarrTrackFileSchema).max(2000));
  }
}

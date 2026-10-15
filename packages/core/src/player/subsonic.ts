/**
 * A small Subsonic API client for the player module: the bundled Navidrome
 * or any Subsonic-compatible server the owner points tagave at.
 *
 * Every call uses token authentication: t = md5(password + salt) with a fresh
 * random salt per request, so the password itself never travels (Navidrome
 * keeps it encrypted at rest and checks the token). The client runs only on
 * the server side; nothing here is ever sent to a browser.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface SubsonicServer {
  /** base URL, e.g. http://player:4533 (no trailing /rest) */
  url: string;
  username: string;
  password: string;
}

/** Subsonic API version tagave speaks (Navidrome implements 1.16.1). */
export const SUBSONIC_API_VERSION = '1.16.1';
/** The client name the server sees; Navidrome keeps a "player" per client name. */
export const SUBSONIC_CLIENT = 'tagave';

const DEFAULT_TIMEOUT_MS = 10_000;

export class SubsonicError extends Error {
  /** Subsonic error code (40 wrong credentials, 70 not found, ...), when the server answered one */
  readonly code: number | null;
  /** HTTP status, when the server answered at all */
  readonly httpStatus: number | null;
  constructor(message: string, opts: { code?: number | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = 'SubsonicError';
    this.code = opts.code ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

export function baseUrl(server: Pick<SubsonicServer, 'url'>): string {
  return server.url.trim().replace(/\/+$/, '').replace(/\/rest$/, '');
}

/** The authentication query parameters for one request (fresh salt each time). */
export function authParams(server: SubsonicServer, salt: string = randomBytes(8).toString('hex')): URLSearchParams {
  const token = createHash('md5').update(server.password + salt, 'utf8').digest('hex');
  return new URLSearchParams({ u: server.username, t: token, s: salt, v: SUBSONIC_API_VERSION, c: SUBSONIC_CLIENT, f: 'json' });
}

type Params = Record<string, string | number | boolean | Array<string | number> | undefined | null>;

/** The URL of a Subsonic method, with authentication. */
export function methodUrl(server: SubsonicServer, method: string, params: Params = {}): string {
  const q = authParams(server);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) q.append(k, String(item));
    else q.set(k, String(v));
  }
  return `${baseUrl(server)}/rest/${method}?${q.toString()}`;
}

/** Plain words for the common Subsonic error codes. */
export function describeSubsonicError(code: number | null, fallback: string): string {
  switch (code) {
    case 40: return 'The server refused the username or password';
    case 41: return 'The server does not accept token sign-in for this user (an LDAP account?)';
    case 50: return 'This user is not allowed to do that on the server';
    case 70: return 'The server does not have that item';
    case 20: case 30: return 'The server speaks an incompatible Subsonic API version';
    default: return fallback;
  }
}

interface SubsonicEnvelope {
  'subsonic-response'?: {
    status?: string;
    version?: string;
    type?: string;
    serverVersion?: string;
    openSubsonic?: boolean;
    error?: { code?: number; message?: string };
    [key: string]: unknown;
  };
}

export type SubsonicResponse = NonNullable<SubsonicEnvelope['subsonic-response']>;

/** Calls a Subsonic method and returns the `subsonic-response` object; throws SubsonicError on any failure. */
export async function subsonicCall(
  server: SubsonicServer,
  method: string,
  params: Params = {},
  opts: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SubsonicResponse> {
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
    : AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(methodUrl(server, method, params), { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    const e = err as Error;
    const why = e.name === 'TimeoutError' ? 'did not answer in time' : `could not be reached (${(e as { cause?: { code?: string } }).cause?.code ?? e.message})`;
    throw new SubsonicError(`The player server at ${baseUrl(server)} ${why}`);
  }
  let body: SubsonicEnvelope;
  try {
    body = (await res.json()) as SubsonicEnvelope;
  } catch {
    throw new SubsonicError(`The player server at ${baseUrl(server)} answered ${res.status} without a Subsonic response; is this the right address?`, { httpStatus: res.status });
  }
  const r = body['subsonic-response'];
  if (!r) throw new SubsonicError(`The server at ${baseUrl(server)} is not a Subsonic-compatible server`, { httpStatus: res.status });
  if (r.status !== 'ok') {
    const code = typeof r.error?.code === 'number' ? r.error.code : null;
    throw new SubsonicError(describeSubsonicError(code, r.error?.message ?? 'The player server refused the request'), { code, httpStatus: res.status });
  }
  return r;
}

export interface PingResult {
  /** OpenSubsonic server name ("navidrome"), or null for a plain Subsonic server */
  type: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  openSubsonic: boolean;
}

export async function ping(server: SubsonicServer, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<PingResult> {
  const r = await subsonicCall(server, 'ping', {}, opts);
  return {
    type: typeof r.type === 'string' ? r.type : null,
    serverVersion: typeof r.serverVersion === 'string' ? r.serverVersion : null,
    apiVersion: typeof r.version === 'string' ? r.version : null,
    openSubsonic: r.openSubsonic === true,
  };
}

/** A song as the server lists it (Subsonic `Child`, with the OpenSubsonic fields tagave uses). */
export interface ServerSong {
  id: string;
  title: string;
  album: string | null;
  albumId: string | null;
  artist: string | null;
  track: number | null;
  discNumber: number | null;
  /** seconds */
  duration: number | null;
  /** the file path; real when the server reports real paths, otherwise a made-up artist/album/title one */
  path: string | null;
  suffix: string | null;
  contentType: string | null;
  /** OpenSubsonic: the recording MBID */
  musicBrainzId: string | null;
}

export interface ServerAlbum {
  id: string;
  name: string;
  artist: string | null;
  songCount: number | null;
  /** OpenSubsonic: the release MBID */
  musicBrainzId: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toServerSong(raw: Record<string, unknown>): ServerSong {
  return {
    id: String(raw['id']),
    title: str(raw['title']) ?? '',
    album: str(raw['album']),
    albumId: str(raw['albumId']),
    artist: str(raw['artist']),
    track: num(raw['track']),
    discNumber: num(raw['discNumber']),
    duration: num(raw['duration']),
    path: str(raw['path']),
    suffix: str(raw['suffix']),
    contentType: str(raw['contentType']),
    musicBrainzId: str(raw['musicBrainzId']),
  };
}

function toServerAlbum(raw: Record<string, unknown>): ServerAlbum {
  return {
    id: String(raw['id']),
    name: str(raw['name']) ?? str(raw['title']) ?? '',
    artist: str(raw['artist']),
    songCount: num(raw['songCount']),
    musicBrainzId: str(raw['musicBrainzId']),
  };
}

/** Words for search3: Subsonic servers search by words, so punctuation only gets in the way. */
export function searchWords(text: string): string {
  return text.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).slice(0, 8).join(' ');
}

export async function search3(
  server: SubsonicServer,
  query: string,
  counts: { albums?: number; songs?: number },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ albums: ServerAlbum[]; songs: ServerSong[] }> {
  const r = await subsonicCall(server, 'search3', {
    query: searchWords(query),
    albumCount: counts.albums ?? 0,
    songCount: counts.songs ?? 0,
    artistCount: 0,
  }, opts);
  const result = (r['searchResult3'] ?? {}) as { album?: Record<string, unknown>[]; song?: Record<string, unknown>[] };
  return { albums: (result.album ?? []).map(toServerAlbum), songs: (result.song ?? []).map(toServerSong) };
}

export async function getAlbum(server: SubsonicServer, id: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<{ album: ServerAlbum; songs: ServerSong[] }> {
  const r = await subsonicCall(server, 'getAlbum', { id }, opts);
  const raw = (r['album'] ?? {}) as Record<string, unknown> & { song?: Record<string, unknown>[] };
  return { album: toServerAlbum(raw), songs: (raw.song ?? []).map(toServerSong) };
}

export interface ScanStatus {
  scanning: boolean;
  count: number | null;
  lastScan: string | null;
}

export async function getScanStatus(server: SubsonicServer, opts: { fetchImpl?: typeof fetch } = {}): Promise<ScanStatus> {
  const r = await subsonicCall(server, 'getScanStatus', {}, opts);
  const s = (r['scanStatus'] ?? {}) as Record<string, unknown>;
  return { scanning: s['scanning'] === true, count: num(s['count']), lastScan: str(s['lastScan']) };
}

/**
 * Asks the server to look for changes. `targets` (Navidrome ≥ 0.59) limits
 * the scan to folders, as "libraryId:path/relative/to/the/library".
 */
export async function startScan(server: SubsonicServer, opts: { targets?: string[]; fetchImpl?: typeof fetch } = {}): Promise<ScanStatus> {
  const r = await subsonicCall(server, 'startScan', opts.targets?.length ? { target: opts.targets } : {}, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), timeoutMs: 15_000 });
  const s = (r['scanStatus'] ?? {}) as Record<string, unknown>;
  return { scanning: s['scanning'] === true, count: num(s['count']), lastScan: str(s['lastScan']) };
}

export async function getMusicFolders(server: SubsonicServer, opts: { fetchImpl?: typeof fetch } = {}): Promise<Array<{ id: number; name: string }>> {
  const r = await subsonicCall(server, 'getMusicFolders', {}, opts);
  const list = ((r['musicFolders'] ?? {}) as { musicFolder?: Array<Record<string, unknown>> }).musicFolder ?? [];
  return list.map((f) => ({ id: Number(f['id']), name: str(f['name']) ?? '' })).filter((f) => Number.isInteger(f.id));
}

/** The stream URL for a song: `raw` passes the file through; anything else transcodes. */
export function streamUrl(
  server: SubsonicServer,
  songId: string,
  opts: { format: 'raw' | 'opus' | 'aac' | 'mp3'; maxBitRate?: number; timeOffset?: number },
): string {
  return methodUrl(server, 'stream', {
    id: songId,
    format: opts.format,
    ...(opts.format !== 'raw' && opts.maxBitRate ? { maxBitRate: opts.maxBitRate } : {}),
    ...(opts.format !== 'raw' && opts.timeOffset ? { timeOffset: opts.timeOffset } : {}),
  });
}

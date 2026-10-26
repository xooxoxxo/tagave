/**
 * The player module's server side: which server plays (bundled or the
 * owner's own), whether it answers, which of its songs is which local track,
 * and the debounced scans that keep it in step with tagave's tag writes.
 *
 * Nothing here reaches the browser except the queue view: the server address
 * and credentials stay in this process (env for the bundled server, sealed
 * library settings for bring-your-own).
 */
import type { PgBoss } from 'pg-boss';
import type postgres from 'postgres';
import type { PlayerAlbumAvailability, PlayerCapability, PlayerQueueTrack, PlayerQueueView, PlayerScanStatus, UnplayableReason } from '@tagave/shared';
import {
  getAlbum,
  getMusicFolders,
  getScanStatus,
  matchTracks,
  musicRelativePath,
  folderOf,
  ping,
  resolvePlayerBackend,
  search3,
  startScan,
  SubsonicError,
  type ExternalPlayerSettings,
  type LocalTrackRef,
  type PlayerBackend,
  type ServerSong,
} from '@tagave/core/player';

type Sql = postgres.Sql;

export const PLAYER_SCAN_QUEUE = 'player.scan';

/** Where tagave's file worker sees the music (the bundled player mounts the same folder). */
export function musicRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['TAGAVE_MUSIC_ROOT']?.trim() || '/mnt/music';
}

function appSecret(): string {
  const s = process.env['APP_SECRET'];
  if (!s) throw new Error('APP_SECRET is not set');
  return s;
}

export interface PlayerLibrarySettings extends ExternalPlayerSettings {
  playerLastScan?: { requestedAt: string; state: 'requested' | 'failed'; error: string | null };
}

/** The server that plays for this library, or null when no player is set up. A sealed password that no longer opens counts as none. */
export function backendFor(settings: PlayerLibrarySettings | null | undefined, env: NodeJS.ProcessEnv = process.env): PlayerBackend | null {
  try {
    return resolvePlayerBackend(settings ?? {}, appSecret(), env);
  } catch {
    return null;
  }
}

export function parseSettings(raw: unknown): PlayerLibrarySettings {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as PlayerLibrarySettings; } catch { return {}; }
  }
  return raw as PlayerLibrarySettings;
}

/**
 * The library row. Every signed-in person on an install reads every library
 * (round 2's household model); what they may change is the route's
 * permission, and their own data is keyed by their user id.
 */
export async function libraryById(sql: Sql, libraryId: string): Promise<{ id: string; settings: PlayerLibrarySettings } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(libraryId)) return null;
  const rows = await sql<{ id: string; settings: unknown }[]>`
    select id, settings from libraries where id = ${libraryId}`;
  return rows[0] ? { id: rows[0].id, settings: parseSettings(rows[0].settings) } : null;
}

/** The install's first library (the one Settings › Playback shows when none is named). */
export async function firstLibrary(sql: Sql): Promise<{ id: string; settings: PlayerLibrarySettings } | null> {
  const rows = await sql<{ id: string; settings: unknown }[]>`select id, settings from libraries order by created_at limit 1`;
  return rows[0] ? { id: rows[0].id, settings: parseSettings(rows[0].settings) } : null;
}

// -- capability ---------------------------------------------------------------

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_FAIL_TTL_MS = 10_000;
const capabilityCache = new Map<string, { at: number; value: PlayerCapability }>();
const PING_TIMEOUT_MS = 8000;

export function clearCapabilityCache(): void {
  capabilityCache.clear();
  scanCache.clear();
  totalCache.clear();
}

export const NOT_INSTALLED: PlayerCapability = { installed: false, managed: null, backend: null, version: null, reachable: false, error: null };

export async function capabilityOf(backend: PlayerBackend | null, opts: { fetchImpl?: typeof fetch; fresh?: boolean } = {}): Promise<PlayerCapability> {
  if (!backend) return NOT_INSTALLED;
  const cached = capabilityCache.get(backend.key);
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < (cached.value.reachable ? CAPABILITY_TTL_MS : CAPABILITY_FAIL_TTL_MS)) return cached.value;
  let value: PlayerCapability;
  try {
    // A server reading a big library (Navidrome's first scan) can be slow to
    // answer; a short timeout here hid every Play button while it scanned.
    const p = await ping(backend.server, { timeoutMs: PING_TIMEOUT_MS, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    value = { installed: true, managed: backend.managed, backend: p.type ?? 'subsonic', version: p.serverVersion, reachable: true, error: null };
  } catch (err) {
    value = { installed: true, managed: backend.managed, backend: null, version: null, reachable: false, error: (err as Error).message };
  }
  capabilityCache.set(backend.key, { at: now, value });
  return value;
}

// -- the server's own scan ----------------------------------------------------------

const SCAN_TTL_MS = 5_000;
const TOTAL_TTL_MS = 5 * 60_000;
const scanCache = new Map<string, { at: number; value: { scanning: boolean; count: number | null; lastScan: string | null } }>();
const totalCache = new Map<string, { at: number; value: number }>();

/** A lastScan the server has really recorded (Navidrome reports the zero time before its first scan ends). */
export function hasScanned(lastScan: string | null): boolean {
  if (!lastScan) return false;
  const t = Date.parse(lastScan);
  return Number.isFinite(t) && new Date(t).getUTCFullYear() >= 2000;
}

/** count / total as a whole percent, held under 100 while the scan runs. */
export function scanPercent(count: number | null, total: number | null): number | null {
  if (count == null || !total || total <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((count / total) * 100)));
}

/** The audio files tagave knows in this library: what a first scan works through. */
async function libraryFileCount(sql: Sql, libraryId: string): Promise<number> {
  const cached = totalCache.get(libraryId);
  if (cached && Date.now() - cached.at < TOTAL_TTL_MS) return cached.value;
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from audio_files af
    join scan_roots sr on sr.id = af.scan_root_id
    where sr.library_id = ${libraryId} and af.status = 'present'`;
  const value = rows[0]?.n ?? 0;
  totalCache.set(libraryId, { at: Date.now(), value });
  return value;
}

/**
 * Is the player server scanning, and how far is it? One getScanStatus,
 * cached for a few seconds so several open pages cost one call.
 */
export async function playerScanStatus(sql: Sql, backend: PlayerBackend, libraryId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<PlayerScanStatus> {
  let raw = scanCache.get(backend.key);
  if (!raw || Date.now() - raw.at >= SCAN_TTL_MS) {
    raw = { at: Date.now(), value: await getScanStatus(backend.server, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
    scanCache.set(backend.key, raw);
  }
  const { scanning, count, lastScan } = raw.value;
  const firstScan = !hasScanned(lastScan);
  const total = scanning && firstScan ? await libraryFileCount(sql, libraryId) : null;
  return { scanning, firstScan, count, total, percent: scanning && firstScan ? scanPercent(count, total) : null };
}

// -- scan requests --------------------------------------------------------------

/**
 * Asks for a (debounced) scan of these folders, relative to the music root;
 * '' scans everything. The job waits a few seconds so a plan writing many
 * albums ends in one scan.
 */
export async function requestPlayerScan(sql: Sql, boss: Pick<PgBoss, 'send'> | null, libraryId: string, folders: string[], delaySeconds = 10): Promise<void> {
  const unique = [...new Set(folders)];
  if (unique.length === 0) return;
  await sql`
    insert into player_scan_requests (library_id, folder)
    select ${libraryId}::uuid, f from unnest(${unique}::text[]) as f
    on conflict (library_id, folder) do update set requested_at = now()`;
  if (boss) {
    await boss.send(PLAYER_SCAN_QUEUE, { libraryId }, { singletonKey: `${PLAYER_SCAN_QUEUE}:${libraryId}`, startAfter: delaySeconds });
  }
}

async function recordLastScan(sql: Sql, libraryId: string, state: 'requested' | 'failed', error: string | null): Promise<void> {
  const value = JSON.stringify({ requestedAt: new Date().toISOString(), state, error });
  await sql`
    update libraries set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{playerLastScan}', ${value}::text::jsonb)
    where id = ${libraryId}`;
}

/** Most targets one startScan names before a full (quick) scan is simpler. */
const MAX_SCAN_TARGETS = 200;

export type ScanOutcome = 'none' | 'busy' | 'started';

/**
 * The player.scan job: drains the library's scan requests into one
 * startScan. While the server is already scanning it leaves them for the
 * next run (the caller re-sends the job). Folder targets only for the
 * bundled server, whose library root is tagave's music root.
 */
export async function runPlayerScan(sql: Sql, libraryId: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<ScanOutcome> {
  const rows = await sql<{ settings: unknown }[]>`select settings from libraries where id = ${libraryId}`;
  if (!rows[0]) return 'none';
  const backend = backendFor(parseSettings(rows[0].settings), opts.env);
  if (!backend) {
    await sql`delete from player_scan_requests where library_id = ${libraryId}`;
    return 'none';
  }
  const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  const status = await getScanStatus(backend.server, f);
  if (status.scanning) return 'busy';
  const taken = await sql<{ folder: string }[]>`
    delete from player_scan_requests where library_id = ${libraryId} returning folder`;
  if (taken.length === 0) return 'none';
  const folders = taken.map((t) => t.folder);
  try {
    let targets: string[] | undefined;
    if (backend.managed === 'bundled' && !folders.includes('') && folders.length <= MAX_SCAN_TARGETS) {
      const lib = (await getMusicFolders(backend.server, f))[0]?.id ?? 1;
      targets = folders.map((folder) => `${lib}:${folder}`);
    }
    await startScan(backend.server, { ...(targets ? { targets } : {}), ...f });
    await recordLastScan(sql, libraryId, 'requested', null);
    return 'started';
  } catch (err) {
    // put them back for the retry
    await sql`
      insert into player_scan_requests (library_id, folder)
      select ${libraryId}::uuid, x from unnest(${folders}::text[]) as x
      on conflict do nothing`;
    await recordLastScan(sql, libraryId, 'failed', (err as Error).message).catch(() => undefined);
    throw err;
  }
}

/** Registers the API's own worker for player.scan (it holds the credentials, so the workers never need them). */
export async function startPlayerScanWorker(boss: PgBoss, sql: Sql, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): Promise<void> {
  await boss.createQueue(PLAYER_SCAN_QUEUE, { policy: 'stately', retryLimit: 5, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800 });
  await boss.work<{ libraryId: string }>(PLAYER_SCAN_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const outcome = await runPlayerScan(sql, job.data.libraryId);
      if (outcome === 'busy') {
        // the server is scanning; ask again shortly (a stately queue keeps one waiting)
        await boss.send(PLAYER_SCAN_QUEUE, job.data, { singletonKey: `${PLAYER_SCAN_QUEUE}:${job.data.libraryId}`, startAfter: 30 });
      }
      if (outcome !== 'none') log.info({ libraryId: job.data.libraryId, outcome }, 'player scan');
    }
  });
}

// -- the album queue: local tracks ↔ server songs ---------------------------------

interface TrackRow {
  id: string;
  disc_no: number | null;
  track_no: number | null;
  title_guess: string | null;
  artist_guess: string | null;
  duration_ms: number | null;
  origin: string;
  rel_path: string;
  container: string | null;
  codec: string | null;
  lossless: boolean | null;
  file_status: string;
  root_path: string;
  recording_mbid: string | null;
  song_id: string | null;
}

export interface AlbumRow {
  id: string;
  library_id: string;
  title_guess: string | null;
  artist_guess: string | null;
  release_id: string | null;
  release_group_id: string | null;
  release_title: string | null;
  release_mbid: string | null;
  embedded_mbid: string | null;
  has_art: boolean;
}

export async function albumById(sql: Sql, albumId: string): Promise<AlbumRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(albumId)) return null;
  const rows = await sql<AlbumRow[]>`
    select la.id, la.library_id, la.title_guess, la.artist_guess, la.release_id, la.release_group_id,
           r.title as release_title, r.mbid as release_mbid, la.embedded_mbid,
           exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front') as has_art
    from local_albums la
    left join releases r on r.id = la.release_id
    where la.id = ${albumId}`;
  return rows[0] ?? null;
}

async function albumTracks(sql: Sql, albumId: string, serverKey: string): Promise<TrackRow[]> {
  return sql<TrackRow[]>`
    select lt.id, lt.disc_no, lt.track_no, lt.title_guess, lt.artist_guess, lt.duration_ms, lt.origin,
           af.rel_path, af.container, af.codec, af.lossless, af.status as file_status, sr.path as root_path,
           coalesce(ct.recording_mbid, rec.mbid) as recording_mbid,
           ptm.song_id
    from local_tracks lt
    join audio_files af on af.id = lt.audio_file_id
    join scan_roots sr on sr.id = af.scan_root_id
    left join canonical_tracks ct on ct.id = lt.canonical_track_id
    left join recordings rec on rec.id = lt.recording_id
    left join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${serverKey}
    where lt.local_album_id = ${albumId}
    order by coalesce(lt.disc_no, 1), lt.track_no nulls last, af.rel_path`;
}

const MIME: Record<string, string> = {
  flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', alac: 'audio/mp4',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma', ape: 'audio/x-ape', wv: 'audio/x-wavpack', dsf: 'audio/x-dsf', dff: 'audio/x-dff',
};

export function mimeFor(container: string | null, relPath: string, codec: string | null): string | null {
  const ext = (relPath.split('.').pop() ?? '').toLowerCase();
  const key = (container ?? ext).toLowerCase();
  if ((key === 'm4a' || key === 'mp4') && codec && /alac/i.test(codec)) return 'audio/mp4; codecs="alac"';
  if ((key === 'ogg' || ext === 'ogg') && codec && /opus/i.test(codec)) return 'audio/ogg; codecs=opus';
  return MIME[key] ?? MIME[ext] ?? null;
}

function trackRef(t: TrackRow, root: string): LocalTrackRef {
  return {
    id: t.id,
    relPath: musicRelativePath(root, t.root_path, t.rel_path) ?? t.rel_path,
    recordingMbid: t.recording_mbid,
    discNo: t.disc_no,
    trackNo: t.track_no,
    title: t.title_guess,
    durationMs: t.duration_ms,
  };
}

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Matches the album's tracks to songs on the server: its album found by
 * release MBID (or by title), then, for tracks still unmatched, songs found
 * by their own titles (a few at most).
 */
async function findSongs(backend: PlayerBackend, album: AlbumRow, refs: LocalTrackRef[], fetchImpl?: typeof fetch) {
  const f = fetchImpl ? { fetchImpl } : {};
  const songs = new Map<string, ServerSong>();
  const title = album.release_title ?? album.title_guess;
  const mbid = (album.release_mbid ?? album.embedded_mbid)?.toLowerCase() ?? null;
  if (title) {
    const { albums } = await search3(backend.server, title, { albums: 20 }, f);
    const byMbid = mbid ? albums.filter((a) => a.musicBrainzId?.toLowerCase() === mbid) : [];
    const byName = albums.filter((a) => norm(a.name) === norm(title) || norm(a.name).startsWith(norm(title)));
    const picks = (byMbid.length ? byMbid : byName).slice(0, 4);
    for (const a of picks) for (const s of (await getAlbum(backend.server, a.id, f)).songs) songs.set(s.id, s);
  }
  let matches = matchTracks(refs, [...songs.values()]);
  const left = refs.filter((r) => !matches.has(r.id) && r.title);
  if (left.length > 0) {
    for (const r of left.slice(0, 12)) {
      const found = await search3(backend.server, r.title!, { songs: 20 }, f);
      for (const s of found.songs) songs.set(s.id, s);
    }
    matches = matchTracks(refs, [...songs.values()]);
  }
  return matches;
}

function unplayableReason(t: TrackRow): UnplayableReason | null {
  if (t.origin === 'cue') return 'cue';
  if (t.file_status !== 'present') return 'no_file';
  return null;
}

export interface QueueDeps {
  sql: Sql;
  boss: Pick<PgBoss, 'send'> | null;
  fetchImpl?: typeof fetch;
}

/**
 * The album as a play queue. Tracks without a cached song are matched now
 * (and cached); what the server does not have yet triggers a scan of those
 * folders and comes back as not_scanned.
 */
export async function albumQueue(deps: QueueDeps, backend: PlayerBackend, album: AlbumRow, opts: { requestScan?: boolean } = {}): Promise<PlayerQueueView> {
  const root = musicRoot();
  let rows = await albumTracks(deps.sql, album.id, backend.key);
  const needs = rows.filter((t) => !t.song_id && unplayableReason(t) === null);
  let scanRequested = false;
  if (needs.length > 0) {
    const refs = needs.map((t) => trackRef(t, root));
    const matches = await findSongs(backend, album, refs, deps.fetchImpl);
    for (const [localTrackId, m] of matches) {
      await deps.sql`
        insert into player_track_map (local_track_id, server_key, song_id, server_album_id, server_path, matched_by)
        values (${localTrackId}, ${backend.key}, ${m.song.id}, ${m.song.albumId}, ${m.song.path}, ${m.matchedBy})
        on conflict (local_track_id) do update set server_key = excluded.server_key, song_id = excluded.song_id,
          server_album_id = excluded.server_album_id, server_path = excluded.server_path,
          matched_by = excluded.matched_by, resolved_at = now()`;
    }
    const missing = refs.filter((r) => !matches.has(r.id));
    if (missing.length > 0 && opts.requestScan !== false) {
      await requestPlayerScan(deps.sql, deps.boss, album.library_id, missing.map((r) => folderOf(r.relPath)));
      scanRequested = true;
    }
    rows = await albumTracks(deps.sql, album.id, backend.key);
  }
  const albumTitle = album.release_title ?? album.title_guess ?? 'Untitled';
  const albumArtist = album.artist_guess ?? 'Unknown artist';
  const tracks: PlayerQueueTrack[] = rows.map((t) => {
    const reason = unplayableReason(t) ?? (t.song_id ? null : 'not_scanned');
    return {
      localTrackId: t.id,
      discNo: t.disc_no && t.disc_no > 0 ? t.disc_no : 1,
      trackNo: t.track_no,
      title: t.title_guess ?? t.rel_path.split('/').pop() ?? 'Untitled',
      artist: t.artist_guess ?? albumArtist,
      album: albumTitle,
      albumArtist,
      durationMs: t.duration_ms,
      container: t.container,
      codec: t.codec,
      lossless: t.lossless,
      mime: mimeFor(t.container, t.rel_path, t.codec),
      available: reason === null,
      reason,
    };
  });
  // what is not on the server yet waits for its scan: say how far that is
  let scan: PlayerScanStatus | null = null;
  if (tracks.some((t) => t.reason === 'not_scanned')) {
    scan = await playerScanStatus(deps.sql, backend, album.library_id, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}).catch(() => null);
  }
  // the credited artists with ids, so the player can link to their pages
  const artists = album.release_group_id
    ? await deps.sql<Array<{ id: string; name: string }>>`
        select rga.artist_id as id, coalesce(nullif(rga.credited_name, ''), a.name) as name
        from release_group_artists rga
        join artists a on a.id = rga.artist_id
        where rga.release_group_id = ${album.release_group_id}
        order by rga.position`
    : [];
  return {
    albumId: album.id,
    album: albumTitle,
    albumArtist,
    artists: artists.map((a) => ({ id: a.id, name: a.name })),
    coverUrl: album.has_art ? `/api/v1/images/album/${album.id}` : null,
    tracks,
    scanRequested,
    scan,
  };
}

/**
 * Can Play start on this album now? The queue's matching without its side
 * effect: an album page asks this on every visit, and a visit must not make
 * the server scan.
 */
export async function albumAvailability(deps: QueueDeps, backend: PlayerBackend, album: AlbumRow): Promise<PlayerAlbumAvailability> {
  const q = await albumQueue(deps, backend, album, { requestScan: false });
  const playable = q.tracks.filter((t) => t.available).length;
  return {
    albumId: album.id,
    tracks: q.tracks.length,
    playable,
    reason: playable > 0 ? null : q.tracks.find((t) => t.reason)?.reason ?? null,
    scan: q.scan ?? null,
  };
}

// -- one track, for the stream and the events ----------------------------------------

export interface TrackForUser {
  id: string;
  local_album_id: string;
  library_id: string;
  release_id: string | null;
  recording_mbid: string | null;
  duration_ms: number | null;
  settings: PlayerLibrarySettings;
}

export async function trackById(sql: Sql, localTrackId: string): Promise<TrackForUser | null> {
  if (!/^[0-9a-f-]{36}$/i.test(localTrackId)) return null;
  const rows = await sql<(Omit<TrackForUser, 'settings'> & { settings: unknown })[]>`
    select lt.id, lt.local_album_id, la.library_id, la.release_id, lt.duration_ms,
           coalesce(ct.recording_mbid, rec.mbid) as recording_mbid, l.settings
    from local_tracks lt
    join local_albums la on la.id = lt.local_album_id
    join libraries l on l.id = la.library_id
    left join canonical_tracks ct on ct.id = lt.canonical_track_id
    left join recordings rec on rec.id = lt.recording_id
    where lt.id = ${localTrackId}`;
  const r = rows[0];
  return r ? { ...r, settings: parseSettings(r.settings) } : null;
}

export async function songIdFor(sql: Sql, localTrackId: string, serverKey: string): Promise<string | null> {
  const rows = await sql<{ song_id: string }[]>`
    select song_id from player_track_map where local_track_id = ${localTrackId} and server_key = ${serverKey}`;
  return rows[0]?.song_id ?? null;
}

export async function forgetSong(sql: Sql, localTrackId: string): Promise<void> {
  await sql`delete from player_track_map where local_track_id = ${localTrackId}`;
}

// -- limits ---------------------------------------------------------------------------

/** Concurrent streams per user: the playing track, the next one preloading, and a seek overlapping them. */
export class StreamLimiter {
  private readonly active = new Map<string, number>();
  constructor(readonly max: number) {}
  acquire(userId: string): (() => void) | null {
    const n = this.active.get(userId) ?? 0;
    if (n >= this.max) return null;
    this.active.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(userId) ?? 1) - 1;
      if (left <= 0) this.active.delete(userId);
      else this.active.set(userId, left);
    };
  }
  count(userId: string): number {
    return this.active.get(userId) ?? 0;
  }
}

/** A fixed-window counter per key (events per user per minute). */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(readonly max: number, readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }
}


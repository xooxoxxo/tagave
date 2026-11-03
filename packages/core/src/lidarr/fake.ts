/**
 * A fake Lidarr (API v1) on 127.0.0.1, for tests and for trying the screens
 * without a real one: the calls the client makes, with Lidarr's shapes, a
 * key check and a log of what was asked. No network beyond the loopback.
 *
 *   const lidarr = await startFakeLidarr({ apiKey: 'k'.repeat(32) });
 *   lidarr.catalog.set(rgMbid, { title, artistMbid, artistName });
 *   … lidarr.download(albumId, 100, 40); lidarr.importAlbum(albumId, ['/music/A/B/01.flac']);
 *   await lidarr.close();
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAlbum {
  id: number;
  foreignAlbumId: string;
  title: string;
  monitored: boolean;
  artistId: number;
  trackCount: number;
  trackFileCount: number;
}

export interface FakeLidarr {
  url: string;
  apiKey: string;
  /** what POST /album may add: release-group MBID → its album and artist */
  catalog: Map<string, { title: string; artistMbid: string; artistName: string; tracks?: number }>;
  artists: Array<{ id: number; foreignArtistId: string; artistName: string; path: string; qualityProfileId: number; metadataProfileId: number }>;
  albums: FakeAlbum[];
  queue: Array<{ id: number; albumId: number; size: number; sizeleft: number; status: string; trackedDownloadState: string }>;
  files: Map<number, string[]>;
  /** every call: method, path with query, and whether the key was right */
  calls: Array<{ method: string; url: string; keyOk: boolean; body: unknown }>;
  commands: Array<{ name: string; albumIds: number[] }>;
  /** answer every call with this status (500, 401…) while set */
  failWith: number | null;
  download(albumId: number, size: number, left: number): void;
  importAlbum(albumId: number, filePaths: string[]): void;
  close(): Promise<void>;
}

export async function startFakeLidarr(opts: { apiKey: string; version?: string; rootFolders?: string[] }): Promise<FakeLidarr> {
  let nextId = 100;
  const rootFolders = opts.rootFolders ?? ['/music'];
  const state: Omit<FakeLidarr, 'url' | 'close' | 'download' | 'importAlbum'> = {
    apiKey: opts.apiKey,
    catalog: new Map(),
    artists: [],
    albums: [],
    queue: [],
    files: new Map(),
    calls: [],
    commands: [],
    failWith: null,
  };

  const albumJson = (a: FakeAlbum) => ({
    id: a.id, foreignAlbumId: a.foreignAlbumId, title: a.title, monitored: a.monitored, artistId: a.artistId, anyReleaseOk: true,
    lastSearchTime: null, releases: [], media: [], images: [],
    statistics: { trackFileCount: a.trackFileCount, trackCount: a.trackCount, totalTrackCount: a.trackCount, sizeOnDisk: 0, percentOfTracks: a.trackCount ? (a.trackFileCount / a.trackCount) * 100 : 0 },
  });

  const read = (req: IncomingMessage) => new Promise<unknown>((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
  });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://fake');
    const body = req.method === 'GET' ? null : await read(req);
    const keyOk = req.headers['x-api-key'] === state.apiKey;
    state.calls.push({ method: req.method ?? 'GET', url: `${u.pathname}${u.search}`, keyOk, body });
    if (state.failWith) return send(res, state.failWith, { message: 'fake failure' });
    if (!keyOk) return send(res, 401, undefined);
    const p = u.pathname.replace(/\/+$/, '').toLowerCase();
    const q = u.searchParams;
    if (req.method === 'GET' && p === '/api/v1/system/status') return send(res, 200, { appName: 'Lidarr', version: opts.version ?? '2.9.6.4552' });
    if (req.method === 'GET' && p === '/api/v1/rootfolder') return send(res, 200, rootFolders.map((path, i) => ({ id: i + 1, name: path.split('/').pop(), path, accessible: true, freeSpace: 1e12 })));
    if (req.method === 'GET' && p === '/api/v1/qualityprofile') return send(res, 200, [{ id: 1, name: 'Any' }, { id: 2, name: 'Lossless' }]);
    if (req.method === 'GET' && p === '/api/v1/metadataprofile') return send(res, 200, [{ id: 1, name: 'Standard' }, { id: 2, name: 'None' }]);
    if (req.method === 'GET' && p === '/api/v1/artist') {
      const mb = q.get('mbId');
      return send(res, 200, mb ? state.artists.filter((a) => a.foreignArtistId === mb) : state.artists);
    }
    if (req.method === 'GET' && p === '/api/v1/album') {
      const f = q.get('foreignAlbumId');
      if (f) return send(res, 200, state.albums.filter((a) => a.foreignAlbumId === f).map(albumJson));
      const ids = q.getAll('albumIds').map(Number);
      return send(res, 200, state.albums.filter((a) => ids.length === 0 || ids.includes(a.id)).map(albumJson));
    }
    if (req.method === 'POST' && p === '/api/v1/album') {
      const b = body as { foreignAlbumId?: string; monitored?: boolean; artist?: { foreignArtistId?: string; rootFolderPath?: string; qualityProfileId?: number; metadataProfileId?: number; artistName?: string } } | null;
      if (!b?.foreignAlbumId || !b.artist?.foreignArtistId) return send(res, 400, [{ propertyName: 'ForeignAlbumId', errorMessage: "'Foreign Album Id' must not be empty." }]);
      if (state.albums.some((a) => a.foreignAlbumId === b.foreignAlbumId)) return send(res, 400, [{ propertyName: 'ForeignAlbumId', errorMessage: 'This album has already been added.' }]);
      const known = state.catalog.get(b.foreignAlbumId);
      if (!known) return send(res, 400, [{ propertyName: 'ForeignAlbumId', errorMessage: 'Album was not found' }]);
      let artist = state.artists.find((a) => a.foreignArtistId === b.artist!.foreignArtistId);
      if (!artist) {
        if (!b.artist.rootFolderPath || !rootFolders.includes(b.artist.rootFolderPath)) return send(res, 400, [{ propertyName: 'RootFolderPath', errorMessage: 'Root folder does not exist' }]);
        artist = { id: nextId++, foreignArtistId: b.artist.foreignArtistId, artistName: known.artistName, path: `${b.artist.rootFolderPath}/${known.artistName}`, qualityProfileId: b.artist.qualityProfileId ?? 1, metadataProfileId: b.artist.metadataProfileId ?? 1 };
        state.artists.push(artist);
      }
      const album: FakeAlbum = { id: nextId++, foreignAlbumId: b.foreignAlbumId, title: known.title, monitored: b.monitored ?? false, artistId: artist.id, trackCount: known.tracks ?? 10, trackFileCount: 0 };
      state.albums.push(album);
      return send(res, 201, albumJson(album));
    }
    if (req.method === 'PUT' && p === '/api/v1/album/monitor') {
      const b = body as { albumIds?: number[]; monitored?: boolean } | null;
      for (const a of state.albums) if (b?.albumIds?.includes(a.id)) a.monitored = !!b.monitored;
      return send(res, 202, state.albums.filter((a) => b?.albumIds?.includes(a.id)).map(albumJson));
    }
    if (req.method === 'POST' && p === '/api/v1/command') {
      const b = body as { name: string; albumIds?: number[] };
      state.commands.push({ name: b.name, albumIds: b.albumIds ?? [] });
      return send(res, 201, { id: nextId++, name: b.name, status: 'queued' });
    }
    if (req.method === 'GET' && p === '/api/v1/queue') {
      return send(res, 200, { page: 1, pageSize: 500, totalRecords: state.queue.length, records: state.queue.map((x) => ({ ...x, title: 'release', protocol: 'torrent' })) });
    }
    if (req.method === 'GET' && p === '/api/v1/trackfile') {
      const id = Number(q.get('albumId'));
      return send(res, 200, (state.files.get(id) ?? []).map((path, i) => ({ id: id * 1000 + i, albumId: id, path })));
    }
    return send(res, 404, { message: 'NotFound' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    download(albumId: number, size: number, left: number) {
      state.queue = state.queue.filter((x) => x.albumId !== albumId);
      state.queue.push({ id: nextId++, albumId, size, sizeleft: left, status: 'downloading', trackedDownloadState: 'downloading' });
    },
    importAlbum(albumId: number, filePaths: string[]) {
      state.queue = state.queue.filter((x) => x.albumId !== albumId);
      const a = state.albums.find((x) => x.id === albumId);
      if (a) a.trackFileCount = filePaths.length;
      state.files.set(albumId, filePaths);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

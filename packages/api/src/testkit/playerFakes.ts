/**
 * Fakes for the player tests: a Navidrome (Subsonic with per-user play
 * counts, ratings, stars and now playing, plus its user API), a Last.fm
 * (signed calls checked) and a ListenBrainz. Nothing here reaches the
 * internet.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSong { id: string; title: string; track: number; discNumber: number; path: string; musicBrainzId?: string; duration: number; albumId?: string; artist?: string; album?: string }
export interface FakeAlbum { id: string; name: string; artist: string; musicBrainzId: string; songs: FakeSong[] }

interface UserState {
  id: string;
  password: string;
  isAdmin: boolean;
  name: string;
  plays: Map<string, { count: number; played: number }>;
  ratings: Map<string, number>;
  starred: Set<string>;
}

const AUDIO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

/** A Navidrome just big enough for the player tests. */
export function fakeNavidrome(adminPassword: string) {
  const users = new Map<string, UserState>();
  const mkUser = (name: string, password: string, isAdmin = false): UserState => {
    const u: UserState = { id: `nd-${randomBytes(4).toString('hex')}`, password, isAdmin, name, plays: new Map(), ratings: new Map(), starred: new Set() };
    users.set(name, u);
    return u;
  };
  mkUser('admin', adminPassword, true);
  const state = {
    users,
    /** the album of the first tests; more can be added to `albums` */
    songs: [] as FakeSong[],
    albumMbid: '' as string,
    albums: [] as FakeAlbum[],
    scanning: false,
    lastScan: '2026-10-01T10:00:00Z' as string | null,
    scans: [] as string[][],
    streams: [] as Array<{ id: string; user: string; format: string | null; range: string | undefined; timeOffset: string | null }>,
    scrobbles: [] as Array<{ user: string; id: string; submission: boolean; time: number | null; client: string | null }>,
    nowPlaying: [] as Array<{ user: string; id: string; at: number; player: string }>,
    goneIds: new Set<string>(),
    hold: false,
    holds: [] as ServerResponse[],
    tokens: new Map<string, string>(),
  };
  const allAlbums = (): FakeAlbum[] => [
    ...(state.songs.length ? [{ id: 'al-1', name: 'Test Album', artist: 'Test Artist', musicBrainzId: state.albumMbid, songs: state.songs.map((s) => ({ ...s, albumId: 'al-1' })) }] : []),
    ...state.albums,
  ];
  const allSongs = () => allAlbums().flatMap((a) => a.songs.map((s) => ({ ...s, albumId: a.id, album: a.name, artist: s.artist ?? a.artist })));
  const songView = (u: UserState, s: FakeSong & { albumId: string }) => {
    const p = u.plays.get(s.id);
    return { ...s, ...(p ? { playCount: p.count, played: new Date(p.played).toISOString() } : {}), ...(u.starred.has(s.id) ? { starred: '2026-10-16T00:00:00Z' } : {}), ...(u.ratings.has(s.id) ? { userRating: u.ratings.get(s.id) } : {}) };
  };
  const albumView = (u: UserState, a: FakeAlbum) => {
    const plays = a.songs.map((s) => u.plays.get(s.id)).filter((p): p is { count: number; played: number } => !!p);
    const played = plays.length ? Math.max(...plays.map((p) => p.played)) : null;
    return {
      id: a.id, name: a.name, artist: a.artist, songCount: a.songs.length, musicBrainzId: a.musicBrainzId,
      ...(played ? { played: new Date(played).toISOString(), playCount: plays.reduce((n, p) => n + p.count, 0) } : {}),
      userRating: u.ratings.get(a.id) ?? 0,
    };
  };
  /** what a phone app does after a track: Subsonic scrobble as that user */
  const phonePlay = (user: string, songId: string, at = Date.now()) => {
    const u = users.get(user)!;
    const p = u.plays.get(songId) ?? { count: 0, played: 0 };
    u.plays.set(songId, { count: p.count + 1, played: at });
  };
  const ok = (res: ServerResponse, body: Record<string, unknown>) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.64.0 (test)', openSubsonic: true, ...body } }));
  };
  const fail = (res: ServerResponse, code: number, message: string) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } }));
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
  const userJson = (name: string, u: UserState) => ({ id: u.id, userName: name, name: u.name, email: '', isAdmin: u.isAdmin, libraries: [{ id: 1 }] });

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // ---- the native API ----
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { username?: string; password?: string };
      const u = body.username ? users.get(body.username) : undefined;
      if (!u || u.password !== body.password) return json(res, 401, { error: 'Invalid username or password' });
      const token = randomBytes(12).toString('hex');
      state.tokens.set(token, body.username!);
      return json(res, 200, { id: u.id, isAdmin: u.isAdmin, token, username: body.username });
    }
    if (url.pathname.startsWith('/api/user')) {
      const auth = req.headers['x-nd-authorization'];
      const who = typeof auth === 'string' ? state.tokens.get(auth.replace(/^Bearer /, '')) : undefined;
      if (!who || !users.get(who)?.isAdmin) return json(res, 401, { error: 'Not authenticated' });
      const id = url.pathname.split('/')[3];
      const byId = id ? [...users.entries()].find(([, u]) => u.id === decodeURIComponent(id)) : undefined;
      if (req.method === 'GET' && !id) return json(res, 200, [...users.entries()].map(([n, u]) => userJson(n, u)));
      if (req.method === 'GET' && byId) return json(res, 200, userJson(byId[0], byId[1]));
      if (req.method === 'POST' && !id) {
        const body = JSON.parse(await readBody(req)) as { userName: string; name: string; password: string; isAdmin: boolean };
        if (users.has(body.userName)) return json(res, 400, { errors: { userName: 'ra.validation.unique' } });
        const u = mkUser(body.userName, body.password, body.isAdmin);
        u.name = body.name;
        return json(res, 200, { id: u.id });
      }
      if (req.method === 'PUT' && byId) {
        const body = JSON.parse(await readBody(req)) as { password?: string; name?: string };
        if (body.password) byId[1].password = body.password;
        if (body.name) byId[1].name = body.name;
        return json(res, 200, userJson(byId[0], byId[1]));
      }
      return json(res, 404, { error: 'not found' });
    }
    // ---- Subsonic ----
    const q = url.searchParams;
    const t = q.get('t');
    const s = q.get('s') ?? '';
    const name = q.get('u') ?? '';
    const u = users.get(name);
    if (q.get('p') || !t || !u || t !== createHash('md5').update(u.password + s).digest('hex')) {
      return fail(res, 40, 'Wrong username or password');
    }
    const method = url.pathname.replace('/rest/', '');
    const albums = allAlbums();
    switch (method) {
      case 'ping': return ok(res, {});
      case 'search3': {
        const query = (q.get('query') ?? '').toLowerCase();
        const found = Number(q.get('albumCount')) > 0 ? albums.filter((a) => a.name.toLowerCase().includes(query)).map((a) => albumView(u, a)) : [];
        const songs = Number(q.get('songCount')) > 0 ? allSongs().filter((x) => x.title.toLowerCase().includes(query)).map((x) => songView(u, x)) : [];
        return ok(res, { searchResult3: { album: found, song: songs } });
      }
      case 'getAlbum': {
        const a = albums.find((x) => x.id === q.get('id'));
        if (!a) return fail(res, 70, 'Album not found');
        return ok(res, { album: { ...albumView(u, a), song: a.songs.map((x) => songView(u, { ...x, albumId: a.id })) } });
      }
      case 'getAlbumList2': {
        const list = albums.map((a) => albumView(u, a));
        const recent = q.get('type') === 'recent' ? list.filter((a) => 'played' in a).sort((x, y) => String((y as { played?: string }).played).localeCompare(String((x as { played?: string }).played))) : list;
        return ok(res, { albumList2: { album: recent.slice(Number(q.get('offset') ?? 0), Number(q.get('offset') ?? 0) + Number(q.get('size') ?? 10)) } });
      }
      case 'getSong': {
        const song = allSongs().find((x) => x.id === q.get('id'));
        return song ? ok(res, { song: songView(u, song) }) : fail(res, 70, 'Song not found');
      }
      case 'scrobble': {
        const id = q.get('id') ?? '';
        const submission = q.get('submission') !== 'false';
        const time = q.get('time') ? Number(q.get('time')) : null;
        state.scrobbles.push({ user: name, id, submission, time, client: q.get('c') });
        if (submission) phonePlay(name, id, time ?? Date.now());
        else state.nowPlaying = [...state.nowPlaying.filter((n) => n.user !== name), { user: name, id, at: Date.now(), player: q.get('c') ?? '' }];
        return ok(res, {});
      }
      case 'getNowPlaying': {
        const entry = state.nowPlaying.map((n) => {
          const song = allSongs().find((x) => x.id === n.id);
          return song ? { ...song, username: n.user, minutesAgo: Math.floor((Date.now() - n.at) / 60_000), playerName: n.player, playerId: 1 } : null;
        }).filter(Boolean);
        return ok(res, { nowPlaying: { entry } });
      }
      case 'setRating': {
        const r = Number(q.get('rating'));
        if (r === 0) u.ratings.delete(q.get('id')!); else u.ratings.set(q.get('id')!, r);
        return ok(res, {});
      }
      case 'star': for (const id of q.getAll('id')) u.starred.add(id); return ok(res, {});
      case 'unstar': for (const id of q.getAll('id')) u.starred.delete(id); return ok(res, {});
      case 'getScanStatus': return ok(res, { scanStatus: { scanning: state.scanning, count: 3, ...(state.lastScan ? { lastScan: state.lastScan } : {}) } });
      case 'getMusicFolders': return ok(res, { musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } });
      case 'startScan': state.scans.push(q.getAll('target')); return ok(res, { scanStatus: { scanning: true, count: 0 } });
      case 'stream': {
        const id = q.get('id') ?? '';
        if (state.goneIds.has(id)) return fail(res, 70, 'Song not found');
        state.streams.push({ id, user: name, format: q.get('format'), range: req.headers.range, timeOffset: q.get('timeOffset') });
        if (state.hold) { state.holds.push(res); res.writeHead(200, { 'content-type': 'audio/flac' }); res.write(AUDIO.subarray(0, 10)); return; }
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (q.get('format') === 'raw' && m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : AUDIO.length - 1;
          res.writeHead(206, { 'content-type': 'audio/flac', 'content-range': `bytes ${start}-${end}/${AUDIO.length}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' });
          return res.end(AUDIO.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': q.get('format') === 'raw' ? 'audio/flac' : 'audio/ogg', 'content-length': String(AUDIO.length), 'accept-ranges': 'bytes' });
        return res.end(AUDIO);
      }
      default: return fail(res, 0, `unknown method ${method}`);
    }
  });
  return { server, state, phonePlay, AUDIO };
}

/** A Last.fm that checks signatures and records what it was sent. */
export function fakeLastfm(apiKey: string, secret: string) {
  const state = {
    /** one entry per scrobble, a batch split into its items */
    scrobbles: [] as Array<Record<string, string>>,
    /** one entry per track.scrobble request */
    calls: [] as Array<Record<string, string>>,
    nowPlaying: [] as Array<Record<string, string>>,
    sessions: new Map<string, string>([['good-token', 'sk-anna']]),
    /** answer the next n scrobbles with error 11 (service offline) */
    failNext: 0,
  };
  const sign = (p: Record<string, string>) => createHash('md5').update(Object.keys(p).filter((k) => k !== 'format' && k !== 'api_sig').sort().map((k) => `${k}${p[k]}`).join('') + secret).digest('hex');
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(raw));
      const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (p['api_key'] !== apiKey) return send({ error: 10, message: 'Invalid API key' });
      if (p['api_sig'] !== sign(p)) return send({ error: 13, message: 'Invalid method signature supplied' });
      switch (p['method']) {
        case 'auth.getToken': return send({ token: 'tok' });
        case 'auth.getSession': {
          const key = state.sessions.get(p['token'] ?? '');
          return key ? send({ session: { name: 'anna-fm', key, subscriber: 0 } }) : send({ error: 4, message: 'Invalid authentication token' });
        }
        case 'track.scrobble':
          state.calls.push(p);
          if (state.failNext > 0) { state.failNext--; return send({ error: 11, message: 'Service Offline' }); }
          if (p['sk'] !== 'sk-anna' && !p['sk']?.startsWith('sk-')) return send({ error: 9, message: 'Invalid session key' });
          if (p['artist[0]'] !== undefined) {
            // a batch: artist[0], track[0], timestamp[0], … up to 49
            const items: Array<Record<string, string>> = [];
            for (let i = 0; p[`artist[${i}]`] !== undefined; i++) {
              const one: Record<string, string> = { sk: p['sk'] ?? '' };
              for (const [k, v] of Object.entries(p)) {
                const m = /^(\w+)\[(\d+)\]$/.exec(k);
                if (m && Number(m[2]) === i) one[m[1]!] = v;
              }
              items.push(one);
            }
            state.scrobbles.push(...items);
            return send({ scrobbles: { '@attr': { accepted: items.length, ignored: 0 }, scrobble: items.map(() => ({ ignoredMessage: { code: '0', '#text': '' } })) } });
          }
          state.scrobbles.push(p);
          return send({ scrobbles: { '@attr': { accepted: 1, ignored: 0 }, scrobble: { ignoredMessage: { code: '0', '#text': '' } } } });
        case 'track.updateNowPlaying':
          state.nowPlaying.push(p);
          return send({ nowplaying: {} });
        default: return send({ error: 3, message: 'Invalid method' });
      }
    });
  });
  return { server, state };
}

/** A ListenBrainz with one valid token per user. */
export function fakeListenbrainz(tokens: Record<string, string>) {
  const state = { listens: [] as Array<{ user: string; body: { listen_type: string; payload: Array<Record<string, unknown>> } }> };
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '').replace(/^Token /, '');
    const user = tokens[auth];
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/1/validate-token') return send(200, user ? { code: 200, valid: true, user_name: user } : { code: 200, valid: false, message: 'Token invalid.' });
    if (req.url === '/1/submit-listens' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (!user) return send(401, { code: 401, error: 'Invalid authorization token.' });
        state.listens.push({ user, body: JSON.parse(raw) });
        send(200, { status: 'ok' });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  return { server, state };
}

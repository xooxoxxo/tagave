#!/usr/bin/env node
/**
 * A fake Last.fm and a fake ListenBrainz for the player end-to-end check
 * (e2e/player-people.e2e.mjs). Nothing reaches the real services.
 *
 *   PORT=3398 LASTFM_KEY=<32 hex> LASTFM_SECRET=<32 hex> node e2e/fake-scrobblers.mjs
 *
 * Last.fm, under /lastfm:
 *   GET  /lastfm/api/auth/?api_key=&cb=   the "allow tagave" page: answers 302 to cb with &token=
 *   POST /lastfm/2.0/                     auth.getToken, auth.getSession, track.scrobble,
 *                                         track.updateNowPlaying (api_sig checked)
 * ListenBrainz, under /listenbrainz: any token "lb-<name>-…" belongs to <name>.
 *   GET  /listenbrainz/1/validate-token
 *   POST /listenbrainz/1/submit-listens
 * GET /_log: everything received; POST /_reset empties it.
 *
 * Point tagave at it with TAGAVE_LASTFM_API_URL=http://127.0.0.1:3398/lastfm/2.0/,
 * TAGAVE_LASTFM_AUTH_URL=http://127.0.0.1:3398/lastfm/api/auth/ and
 * TAGAVE_LISTENBRAINZ_API_URL=http://127.0.0.1:3398/listenbrainz.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3398);
const KEY = process.env.LASTFM_KEY ?? 'a'.repeat(32);
const SECRET = process.env.LASTFM_SECRET ?? 'b'.repeat(32);

const log = { lastfm: { sessions: [], scrobbles: [], nowPlaying: [], refused: [] }, listenbrainz: { listens: [], refused: [] } };
const tokens = new Map(); // Last.fm auth token -> session key
let people = 0;

const sign = (p) => createHash('md5').update(Object.keys(p).filter((k) => k !== 'format' && k !== 'api_sig').sort().map((k) => `${k}${p[k]}`).join('') + SECRET).digest('hex');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/_log') return json(res, 200, log);
  if (url.pathname === '/_reset' && req.method === 'POST') {
    for (const k of Object.keys(log.lastfm)) log.lastfm[k] = [];
    for (const k of Object.keys(log.listenbrainz)) log.listenbrainz[k] = [];
    return json(res, 200, { ok: true });
  }
  // ---- Last.fm ----
  if (url.pathname === '/lastfm/api/auth/') {
    const cb = url.searchParams.get('cb');
    if (url.searchParams.get('api_key') !== KEY || !cb) return json(res, 400, { error: 'bad request' });
    const token = `tok${randomBytes(8).toString('hex')}`;
    people += 1;
    tokens.set(token, { key: `sk-${people}-${randomBytes(4).toString('hex')}`, name: `fm-listener-${people}` });
    res.writeHead(302, { location: `${cb}${cb.includes('?') ? '&' : '?'}token=${token}` });
    return res.end();
  }
  if (url.pathname === '/lastfm/2.0/' && req.method === 'POST') {
    const p = Object.fromEntries(new URLSearchParams(await body(req)));
    if (p.api_key !== KEY) return json(res, 200, { error: 10, message: 'Invalid API key' });
    if (p.api_sig !== sign(p)) return json(res, 200, { error: 13, message: 'Invalid method signature supplied' });
    const sessionKeys = [...tokens.values()].map((t) => t.key);
    switch (p.method) {
      case 'auth.getToken': return json(res, 200, { token: 'unused' });
      case 'auth.getSession': {
        const t = tokens.get(p.token);
        if (!t) return json(res, 200, { error: 4, message: 'Invalid authentication token' });
        log.lastfm.sessions.push({ name: t.name, at: new Date().toISOString() });
        return json(res, 200, { session: { name: t.name, key: t.key, subscriber: 0 } });
      }
      case 'track.scrobble':
        if (!sessionKeys.includes(p.sk)) { log.lastfm.refused.push(p); return json(res, 200, { error: 9, message: 'Invalid session key' }); }
        log.lastfm.scrobbles.push({ ...p, user: [...tokens.values()].find((t) => t.key === p.sk)?.name, receivedAt: new Date().toISOString() });
        return json(res, 200, { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
      case 'track.updateNowPlaying':
        log.lastfm.nowPlaying.push({ ...p, user: [...tokens.values()].find((t) => t.key === p.sk)?.name, receivedAt: new Date().toISOString() });
        return json(res, 200, { nowplaying: {} });
      default: return json(res, 200, { error: 3, message: 'Invalid method' });
    }
  }
  // ---- ListenBrainz ----
  if (url.pathname.startsWith('/listenbrainz/1/')) {
    const token = String(req.headers.authorization ?? '').replace(/^Token /, '');
    const m = /^lb-([a-z0-9]+)-/.exec(token);
    const user = m ? m[1] : null;
    if (url.pathname === '/listenbrainz/1/validate-token') return json(res, 200, user ? { code: 200, valid: true, user_name: user } : { code: 200, valid: false, message: 'Token invalid.' });
    if (url.pathname === '/listenbrainz/1/submit-listens' && req.method === 'POST') {
      const b = JSON.parse(await body(req));
      if (!user) { log.listenbrainz.refused.push(b); return json(res, 401, { code: 401, error: 'Invalid authorization token.' }); }
      log.listenbrainz.listens.push({ user, type: b.listen_type, payload: b.payload, receivedAt: new Date().toISOString() });
      return json(res, 200, { status: 'ok' });
    }
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`fake Last.fm + ListenBrainz on http://127.0.0.1:${PORT}`));

#!/usr/bin/env node
/**
 * Music Connections end to end (spec §6): tagave and review-gatherer, each
 * with a signed-in person, linked both ways over HTTP with session cookies.
 * Each app starts the link to the other and the person approves it on the
 * other app's consent step. Then:
 *
 *   1. a rating given in tagave (4.5) shows on review-gatherer's album page
 *      for that person (its album API: 9 of 10, from tagave);
 *   2. review-gatherer's critic scores show in tagave's review panel (the
 *      reviews API's critic-scores facet, labelled "(via review-gatherer)");
 *   3. a suggestion accepted in tagave is gone from review-gatherer's next
 *      wantlist-suggestions feed: read with a token of the test's own, the
 *      page after the accept carries its tombstone and a fresh snapshot no
 *      longer offers it.
 *
 * Run by scripts/mc-e2e.sh inside the compose network (e2e/mc/compose.yml):
 *
 *   node mc.e2e.mjs wait   until both apps answer
 *   node mc.e2e.mjs run    the checks (TAGAVE_URL, RG_URL)
 *
 * The other app's seed must hold the three FIXTURE albums with critic
 * reviews; tagave's (tagave-seed.sql) holds the first two.
 */
import { createHash, randomBytes } from 'node:crypto';

const TAGAVE = process.env.TAGAVE_URL;
const RG = process.env.RG_URL;
if (!TAGAVE || !RG) throw new Error('TAGAVE_URL and RG_URL are required');

const FIXTURE = {
  rated: { mbid: '3f0a1e52-6d6b-4c1e-9a0e-0000000e2e01', title: 'MC E2E Rated', tagaveId: '00000000-0000-4000-8000-00000000e201' },
  scored: { mbid: '3f0a1e52-6d6b-4c1e-9a0e-0000000e2e02', title: 'MC E2E Scored', tagaveId: '00000000-0000-4000-8000-00000000e202' },
  suggested: { mbid: '3f0a1e52-6d6b-4c1e-9a0e-0000000e2e03', title: 'MC E2E Suggested' },
};
const PERSON = { email: 'e2e@example.org', password: 'mc-e2e-password-1234', name: 'E2E' };
const SLOW_MS = 180_000;

// ── HTTP with a cookie jar, no redirects followed ─────────────────────────

class Session {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  async req(url, { method = 'GET', json, form, headers = {} } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') h.origin = new URL(url).origin;
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const location = res.headers.get('location');
    return { status: res.status, data, location: location ? new URL(location, url).href : null };
  }
}

const SECRET_KEYS = new Set(['client_secret', 'access_token', 'refresh_token']);
/** Failure details without secrets: never print a token or a client secret. */
const redact = (v) => JSON.stringify(v, (k, x) => (SECRET_KEYS.has(k) && typeof x === 'string' ? '[redacted]' : x));
function expect(ok, what, detail) {
  if (!ok) throw new Error(`${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : redact(detail)}`}`);
}
const results = [];
const pass = (name, detail = '') => { results.push(name); console.log(`ok   ${name}${detail ? ` - ${detail}` : ''}`); };

async function until(what, fn, ms = SLOW_MS) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err.message; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out: ${what}${last ? ` (last: ${typeof last === 'string' ? last : redact(last)})` : ''}`);
}

// ── review-gatherer: its sign-in and consent steps ────────────────────────
// Better Auth email sign-up, its OIDC consent endpoint, and the RG routes
// for linking, syncing, the weekly picks and the album page.

const rg = {
  async signUp(s) {
    const r = await s.req(`${RG}/api/auth/sign-up/email`, { method: 'POST', json: PERSON });
    expect(r.status === 200, 'review-gatherer sign-up', r);
  },
  /** Follow an authorize URL as the signed-in person and approve: the client's redirect URL with the code. */
  async approve(s, authorizeUrl) {
    const a = await s.req(authorizeUrl);
    const to = a.location ?? a.data?.url ?? a.data?.redirectURI;
    expect(typeof to === 'string', 'review-gatherer authorize redirects', a);
    const next = new URL(to, authorizeUrl).href;
    if (new URL(next).searchParams.get('code')) return next;
    const consentCode = new URL(next).searchParams.get('consent_code');
    expect(consentCode, 'review-gatherer asks for consent', next);
    const c = await s.req(`${RG}/api/auth/oauth2/consent`, { method: 'POST', json: { accept: true, consent_code: consentCode } });
    const back = c.data?.redirectURI ?? c.data?.url ?? c.location;
    expect(c.status === 200 && typeof back === 'string', 'review-gatherer consent accepted', c);
    return new URL(back, authorizeUrl).href;
  },
  primePicks: (s) => s.req(`${RG}/api/my/queue`),
  links: async (s) => (await s.req(`${RG}/api/my/connections`)).data?.links ?? [],
  albumId: async (s, title) => (await s.req(`${RG}/api/albums?q=${encodeURIComponent(title)}`)).data?.albums?.find((a) => a.title === title)?.id,
  album: async (s, id) => (await s.req(`${RG}/api/albums/${id}`)).data,
};

// ── tagave ────────────────────────────────────────────────────────────────

const tg = {
  async setup(s) {
    const r = await s.req(`${TAGAVE}/api/v1/auth/setup`, { method: 'POST', json: { email: PERSON.email, password: PERSON.password, displayName: PERSON.name, contactString: PERSON.email } });
    expect(r.status === 201, 'tagave owner setup', r);
    const libs = await s.req(`${TAGAVE}/api/v1/libraries`);
    const id = libs.data?.data?.[0]?.id;
    expect(id, 'tagave library', libs);
    return id;
  },
  /** Follow an authorize URL as the signed-in person and approve on the consent page's API. */
  async approve(s, authorizeUrl) {
    const a = await s.req(authorizeUrl);
    const request = a.location && new URL(a.location).searchParams.get('request');
    expect(request, 'tagave authorize sends to its consent page', a);
    const shown = await s.req(`${TAGAVE}/api/v1/connect/requests/${encodeURIComponent(request)}`);
    expect(shown.status === 200, 'tagave consent page names the app', shown);
    const d = await s.req(`${TAGAVE}/api/v1/connect/requests/${encodeURIComponent(request)}/decision`, { method: 'POST', json: { decision: 'approve' } });
    expect(d.status === 200 && typeof d.data?.redirect === 'string', 'tagave approval', d);
    return d.data.redirect;
  },
};

// ── a Music Connections client of the test's own (protocol only) ──────────

async function ownClient(s, base, scope) {
  const manifest = (await s.req(`${base}/.well-known/music-connections`)).data;
  const abs = (u) => new URL(u, base).href;
  const redirectUri = 'http://127.0.0.1/mc-e2e/callback';
  const reg = await s.req(abs(manifest.auth.register), { method: 'POST', json: { client_name: 'mc-e2e observer', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' } });
  expect(reg.status === 200 || reg.status === 201, 'observer registers', reg);
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code', client_id: reg.data.client_id, redirect_uri: redirectUri, scope, state: randomBytes(12).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const back = await rg.approve(s, `${abs(manifest.auth.authorize)}?${q}`);
  const code = new URL(back).searchParams.get('code');
  expect(code, 'observer gets a code', back);
  const t = await new Session('observer').req(abs(manifest.auth.token), { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.data.client_id, client_secret: reg.data.client_secret, code_verifier: verifier } });
  expect(t.status === 200 && t.data?.access_token, 'observer token', t);
  const feedUrl = (cap) => abs(manifest.provides[cap]);
  /** Every page from `since` (or a snapshot): items and the last cursor. */
  return async function feed(cap, since) {
    const items = [];
    let cursor = since;
    for (let page = 0; page < 50; page++) {
      const u = new URL(feedUrl(cap));
      if (cursor) u.searchParams.set('since', cursor);
      const r = await new Session('feed').req(u.href, { headers: { authorization: `Bearer ${t.data.access_token}` } });
      expect(r.status === 200, `${cap} feed`, r);
      items.push(...r.data.items);
      cursor = r.data.next;
      if (!r.data.more) break;
    }
    return { items, next: cursor };
  };
}

// ── the run ───────────────────────────────────────────────────────────────

async function waitForApps() {
  await until('tagave health', async () => (await fetch(`${TAGAVE}/api/v1/health`)).ok, 300_000);
  await until('review-gatherer manifest', async () => (await fetch(`${RG}/.well-known/music-connections`)).ok, 300_000);
  console.log('both apps answer');
}

async function run() {
  const t = new Session('tagave');
  const r = new Session('review-gatherer');
  const libraryId = await tg.setup(t);
  await rg.signUp(r);
  pass('a signed-in person on each side');

  // A rating in tagave before the link: it travels in the first pull.
  const put = await t.req(`${TAGAVE}/api/v1/libraries/${libraryId}/release-groups/${FIXTURE.rated.tagaveId}/review`, { method: 'PUT', json: { rating: 4.5 } });
  expect(put.status === 200 || put.status === 201, 'tagave rating saved', put);
  // review-gatherer's weekly picks: its wantlist suggestions for this person.
  const picks = await rg.primePicks(r);
  expect(picks.data?.items?.some((i) => i.albumTitle === FIXTURE.suggested.title), 'review-gatherer picks the suggested album', picks.data);

  // tagave adds review-gatherer: tagave registers there, the person approves there.
  const start = await t.req(`${TAGAVE}/api/v1/me/connections`, { method: 'POST', json: { url: RG } });
  expect(start.status === 200 && start.data?.authorizeUrl, 'tagave starts the link', start);
  const back = await t.req(await rg.approve(r, start.data.authorizeUrl));
  expect(back.location?.includes('/settings/connections?linked='), 'tagave keeps the link', back);
  pass('tagave linked to review-gatherer', 'approved on review-gatherer');

  // review-gatherer adds tagave: it registers here, the person approves on tagave's consent step.
  const rstart = await r.req(`${RG}/api/my/connections/start`, { method: 'POST', json: { url: TAGAVE } });
  expect(rstart.status === 200 && rstart.data?.authorizeUrl, 'review-gatherer starts the link', rstart);
  const rback = await r.req(await tg.approve(t, rstart.data.authorizeUrl));
  expect(rback.location?.includes('linked='), 'review-gatherer keeps the link', rback);
  pass('review-gatherer linked to tagave', 'approved on tagave');

  // (2) review-gatherer's critic scores in tagave's review panel.
  const panel = await until('critic scores in the review panel', async () => {
    const p = await t.req(`${TAGAVE}/api/v1/libraries/${libraryId}/release-groups/${FIXTURE.scored.tagaveId}/reviews`);
    const v = p.data?.criticScores?.values?.find((x) => x.source.module === 'mc');
    return v && v.reviews.length >= 2 ? v : null;
  });
  expect(panel.source.label === 'review-gatherer', 'scores labelled with the app', panel.source);
  expect(panel.reviews.every((x) => x.label.endsWith('(via review-gatherer)') && typeof x.score === 'number'), 'each review scored and labelled', panel.reviews);
  expect(panel.criticRatings.some((x) => x.score === 8), 'the critic rating came along', panel.criticRatings);
  pass('(2) review-gatherer critic scores in tagave\'s review panel', panel.reviews.map((x) => `${x.label} ${x.score}`).join(', '));

  // (1) the tagave rating on review-gatherer's album page.
  const link = (await rg.links(r)).find((l) => l.remoteUrl === TAGAVE);
  expect(link, 'review-gatherer lists the link', await rg.links(r));
  const sync = await r.req(`${RG}/api/my/connections/${link.id}/sync`, { method: 'POST' });
  expect(sync.status === 202 || sync.status === 409, 'review-gatherer sync now', sync);
  const albumId = await rg.albumId(r, FIXTURE.rated.title);
  expect(albumId, 'review-gatherer has the rated album');
  const mine = await until('the tagave rating on the album page', async () => {
    const m = (await rg.album(r, albumId))?.album?.mine;
    return m?.rating ? m : null;
  });
  expect(mine.rating.value === 9 && mine.rating.source === 'tagave', 'rating 4.5 of 5 shows as 9 of 10 from tagave', mine);
  pass('(1) tagave rating on review-gatherer\'s album page', `${mine.rating.value} from ${mine.rating.source}`);

  // (3) accept a suggestion in tagave; it leaves review-gatherer's next feed.
  const feed = await ownClient(r, RG, 'wantlist-suggestions:read');
  const before = await feed('wantlist-suggestions');
  const offered = before.items.find((i) => i.op === 'upsert' && i.data?.album?.rg_mbid === FIXTURE.suggested.mbid);
  expect(offered, 'the feed offers the suggested album', before.items.map((i) => [i.op, i.data?.album?.title]));
  const suggestion = await until('the suggestion in tagave', async () => {
    const w = await t.req(`${TAGAVE}/api/v1/me/wantlist?libraryId=${libraryId}`);
    return w.data?.suggestions?.find((x) => x.title === FIXTURE.suggested.title && x.decision === null) ?? null;
  });
  const decided = await t.req(`${TAGAVE}/api/v1/me/wantlist-suggestions/${suggestion.id}/decision`, { method: 'POST', json: { decision: 'accepted', libraryId } });
  expect(decided.status === 200 && decided.data?.decision === 'accepted', 'tagave accepts it at review-gatherer', decided);
  const after = await feed('wantlist-suggestions', before.next);
  expect(after.items.some((i) => i.key === offered.key && i.op === 'delete'), 'the next page tombstones it', after.items);
  const fresh = await feed('wantlist-suggestions');
  expect(!fresh.items.some((i) => i.key === offered.key && i.op === 'upsert'), 'a fresh snapshot no longer offers it', fresh.items);
  const kept = await t.req(`${TAGAVE}/api/v1/me/wantlist?libraryId=${libraryId}`);
  expect(kept.data?.wantlist?.some((e) => e.title === FIXTURE.suggested.title), 'tagave keeps it on its wantlist', kept.data);
  pass('(3) accepted suggestion gone from the next suggestions feed', `key ${offered.key}`);

  console.log(`\nall ${results.length} checks passed`);
}

const mode = process.argv[2] ?? 'run';
try {
  if (mode === 'wait') await waitForApps();
  else if (mode === 'run') await run();
  else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  console.error(`FAIL ${err.message}`);
  if (process.env.MC_E2E_DEBUG) console.error(err.stack);
  process.exit(1);
}

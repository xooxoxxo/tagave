/**
 * From an empty install to a library worth photographing: the owner
 * account (demo@example.com, a password that lives only in memory), the
 * scan root, the first scan, then a wait until the worker has nothing
 * left to do (identification, enrichment, cover art, thumbnails, gaps).
 */
import { randomBytes } from 'node:crypto';

const rows = (x) => x?.data ?? x?.items ?? x;

export const DEMO = { email: 'demo@example.com', name: 'Demo' };
const CONTACT = 'https://github.com/xooxoxxo/tagave';

/** fetch with a cookie jar and the Origin header sign-in insists on. */
export function apiClient(baseUrl) {
  const jar = new Map();
  async function call(method, p, body) {
    const res = await fetch(`${baseUrl}/api/v1${p}`, {
      method,
      headers: {
        origin: baseUrl,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    return data;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    cookies: () => [...jar].map(([name, value]) => ({ name, value })),
  };
}

/** Jobs the worker still has to run (scheduled sweeps far in the future do not count). */
async function pendingJobs(sql) {
  return sql`
    select name, state, count(*)::int as n
      from pgboss.job
     where state in ('created', 'retry', 'active')
       and start_after < now() + interval '2 minutes'
     group by name, state
     order by name`;
}

export async function waitForIdle(sql, until, log, { timeoutMs = 20 * 60_000, label = 'the worker to finish' } = {}) {
  let quiet = 0;
  let lastLine = '';
  await until(label, async () => {
    const rows = await pendingJobs(sql);
    const line = rows.map((r) => `${r.name}:${r.state}=${r.n}`).join(' ');
    if (line && line !== lastLine) log(`    ${line}`);
    lastLine = line;
    quiet = rows.length === 0 ? quiet + 1 : 0;
    return quiet >= 3; // idle for three polls in a row
  }, { timeoutMs, everyMs: 4000 });
}

export async function prepareLibrary({ stack, sql, musicDir, library, log, until }) {
  const api = apiClient(stack.baseUrl);
  const password = randomBytes(18).toString('base64url');

  log('owner account');
  await api.post('/auth/setup', { email: DEMO.email, password, displayName: DEMO.name, contactString: CONTACT });
  if (!api.cookies().length) {
    await api.post('/auth/login', { email: DEMO.email, password });
  }
  const libs = await api.get('/libraries');
  const libraryId = rows(libs)[0]?.id;
  if (!libraryId) throw new Error(`no library after setup: ${JSON.stringify(libs).slice(0, 200)}`);

  log('scan root');
  const root = await api.post(`/libraries/${libraryId}/scan-roots`, { path: musicDir, displayName: 'Music', writable: true, enabled: true, pollIntervalS: 21600 });
  await until('the worker to validate the scan root', async () => {
    const list = await api.get(`/libraries/${libraryId}/scan-roots`);
    const r = rows(list).find((x) => x.id === root.id);
    if (r?.validationStatus && r.validationStatus !== 'pending' && r.validationStatus !== 'ok') throw new Error(`scan root ${r.validationStatus}: ${r.validationMessage}`);
    return r?.validationStatus === 'ok';
  }, { timeoutMs: 120_000, everyMs: 1000 });
  await api.patch(`/libraries/${libraryId}/settings`, { onboardingCompletedAt: new Date().toISOString() });

  log('first scan');
  await api.post(`/libraries/${libraryId}/scan-roots/${root.id}/scan`, { mode: 'full' });
  await waitForIdle(sql, until, log);

  // The worker identifies on a 5-minute sweep; ask for it now.
  log('identification and enrichment');
  await api.post(`/libraries/${libraryId}/identify/sweep`);
  await waitForIdle(sql, until, log);

  log('cover art');
  const albums = await sql`select id, state, title_guess, artist_guess, release_group_id from local_albums where library_id = ${libraryId}`;
  for (const a of albums) await api.post(`/libraries/${libraryId}/albums/${a.id}/fetch-art`);
  await waitForIdle(sql, until, log);
  const noArt = await sql`select title_guess from local_albums la where library_id = ${libraryId}
    and not exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front')`;
  if (noArt.length) throw new Error(`no cover art for: ${noArt.map((r) => r.title_guess).join(', ')}`);

  log('library care');
  await api.post(`/libraries/${libraryId}/gaps/recompute`);
  await waitForIdle(sql, until, log);

  const byCase = (c) => library.find((a) => a.case === c);
  const find = (entry, extra = () => true) => {
    const hit = albums.filter((a) => a.title_guess?.toLowerCase() === entry.releaseTitle.toLowerCase() && extra(a));
    if (!hit.length) throw new Error(`album not found after the scan: ${entry.releaseTitle}`);
    return hit;
  };
  const unmatched = albums.filter((a) => a.state !== 'matched');
  const expectedUnmatched = find(byCase('compilation-split')).length;
  if (unmatched.length !== expectedUnmatched) {
    throw new Error(`expected only the ${expectedUnmatched} compilation pieces unidentified, got ${unmatched.length}: ${unmatched.map((a) => `${a.artist_guess} — ${a.title_guess} (${a.state})`).join('; ')}`);
  }

  log('tag plan preview');
  await api.patch(`/libraries/${libraryId}/settings`, { tagWritesEnabled: true });
  const messy = byCase('messy-tags');
  const [messyAlbum] = find(messy);
  const plan = await api.post(`/libraries/${libraryId}/tag-plans`, {
    name: messy.releaseTitle,
    scope: { type: 'albumIds', albumIds: [messyAlbum.id] },
    policy: { preset: 'canonical_ids_and_fill' },
  });
  await api.post(`/libraries/${libraryId}/tag-plans/${plan.id}/preview`);
  await waitForIdle(sql, until, log);
  // the first file is the one shown expanded
  const [planFile] = await sql`select rel_path from audio_files where library_id = ${libraryId} and rel_path like ${`${messy.folders[0]}/01 %`}`;
  if (!planFile) throw new Error('the tag plan file is missing');

  log('album page: critic scores, a rating, a listen');
  const feature = library.find((a) => a.feature);
  const [featureAlbum] = find(feature);
  await api.post(`/libraries/${libraryId}/release-groups/${featureAlbum.release_group_id}/reviews/refresh`);
  await api.put(`/libraries/${libraryId}/release-groups/${featureAlbum.release_group_id}/review`, { rating: 4.5 });
  await api.post(`/libraries/${libraryId}/release-groups/${featureAlbum.release_group_id}/listens`, {});
  await waitForIdle(sql, until, log);

  const pieces = find(byCase('compilation-split'));
  const compilationPiece = pieces.slice().sort((a, b) => a.artist_guess.localeCompare(b.artist_guess)).find((a) => a.artist_guess === 'Iggy Pop') ?? pieces[0];

  const counts = await sql`select state, count(*)::int as n from local_albums where library_id = ${libraryId} group by state order by state`;
  log(`  albums: ${counts.map((c) => `${c.state}=${c.n}`).join(' ')}`);

  const hooks = {
    // after the compilation shot: treat the pieces as one album, as the offer says
    compilation: async () => {
      log('  treating the compilation pieces as one album');
      await api.post(`/libraries/${libraryId}/albums/merge`, { albumIds: pieces.map((p) => p.id), targetId: compilationPiece.id });
      await waitForIdle(sql, until, log);
    },
  };

  return {
    api, libraryId, email: DEMO.email, password, hooks,
    ids: { compilationPiece: compilationPiece.id, planId: plan.id, planFile: planFile.rel_path.split('/').pop(), featureAlbum: featureAlbum.id },
  };
}

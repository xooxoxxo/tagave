#!/usr/bin/env node
/**
 * A stand-in for the opt-in updater and the release feed, for the e2e runs
 * only. It does not check the app's signature and changes nothing: it
 * answers GET /v1/status, records POST /v1/update and serves a GitHub-style
 * releases list at GET /releases.
 *
 *   PORT=3299 RELEASES=0.7.3 node e2e/fake-updater.mjs
 *
 * GET  /_test/updates           the update requests it received
 * POST /_test/run?status=…      set the run it reports (running, succeeded, …); a running run keeps its id
 * POST /_test/releases?list=…   set the releases the feed lists (comma separated, empty for none)
 * POST /_test/reset             forget runs and requests
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3299);
let RELEASES = (process.env.RELEASES ?? '0.7.3').split(',').filter(Boolean);
const FROM = process.env.FROM ?? '0.7.2';

const requests = [];
let run = null;

const LABELS = {
  preflight: 'Check the install',
  backup: 'Back up the database',
  config: 'Set the new version',
  pull: 'Download the images',
  restart: 'Restart tagave',
  verify: 'Check it runs',
  rollback: 'Roll back',
};

function makeRun(target, status) {
  const now = Date.now();
  const ids = Object.keys(LABELS);
  const runningAt = status === 'running' ? 3 : ids.length - 1;
  const steps = ids.map((id, i) => {
    const done = status !== 'running' || i < runningAt;
    const st = id === 'rollback' ? 'skipped' : status === 'running' && i === runningAt ? 'running' : done ? 'done' : 'pending';
    return {
      id,
      label: LABELS[id],
      status: st,
      startedAt: st === 'pending' || st === 'skipped' ? null : new Date(now - (ids.length - i) * 9000).toISOString(),
      finishedAt: st === 'done' ? new Date(now - (ids.length - i - 1) * 9000).toISOString() : null,
    };
  });
  return {
    id: `run-${now}`,
    from: FROM,
    target,
    status,
    startedAt: new Date(now - 64000).toISOString(),
    finishedAt: status === 'running' ? null : new Date(now).toISOString(),
    steps,
    log: [
      { at: new Date(now - 60000).toISOString(), level: 'info', message: 'preflight: compose file and .env found' },
      { at: new Date(now - 50000).toISOString(), level: 'info', message: 'backup: tagave-pre-update.dump (verified)' },
      { at: new Date(now - 30000).toISOString(), level: 'info', message: `pull: ghcr.io/example/tagave-app:${target}` },
    ],
    reason: null,
    backup: 'tagave-pre-update.dump',
    rollback: null,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/v1/status') {
    return send(res, 200, { version: FROM, configuredVersion: FROM, role: 'all', services: ['app', 'worker'], run });
  }
  if (req.method === 'POST' && url.pathname === '/v1/update') {
    const body = JSON.parse((await readBody(req)) || '{}');
    requests.push({ at: new Date().toISOString(), version: body.version });
    run = makeRun(body.version, 'running');
    return send(res, 202, { run });
  }
  if (req.method === 'GET' && url.pathname === '/releases') {
    return send(res, 200, RELEASES.map((v, i) => ({
      tag_name: `v${v}`,
      name: `v${v}`,
      body: `- Fixes for the in-app update.\n- Smaller things.`,
      published_at: new Date(Date.now() - i * 86400000).toISOString(),
      html_url: `https://example.test/releases/v${v}`,
      draft: false,
      prerelease: false,
    })));
  }
  if (req.method === 'GET' && url.pathname === '/_test/updates') return send(res, 200, requests);
  if (req.method === 'POST' && url.pathname === '/_test/run') {
    const status = url.searchParams.get('status');
    const target = url.searchParams.get('target') ?? RELEASES[0];
    // a running run that finishes keeps its id, as the real updater's does
    const next = status ? makeRun(target, status) : null;
    if (next && run?.status === 'running' && run.target === target) next.id = run.id;
    run = next;
    return send(res, 200, { run });
  }
  if (req.method === 'POST' && url.pathname === '/_test/releases') {
    RELEASES = (url.searchParams.get('list') ?? '').split(',').filter(Boolean);
    return send(res, 200, { releases: RELEASES });
  }
  if (req.method === 'POST' && url.pathname === '/_test/reset') {
    requests.length = 0;
    run = null;
    return send(res, 200, {});
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake updater on http://127.0.0.1:${PORT}`));

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateRun } from '@tagave/shared/updater';
import { SignatureVerifier, signRequest, SIGNATURE_HEADER, TIME_HEADER } from './token.js';
import { UpdaterService, STATE_DIR } from './server.js';
import { DEFAULT_CONFIG, newRun } from './update.js';

const SECRET = 'a'.repeat(44);

describe('request signatures', () => {
  const req = (h: Record<string, string>, body = '') => ({ method: 'POST', path: '/v1/update', body, time: h[TIME_HEADER], signature: h[SIGNATURE_HEADER] });

  it('accepts a signed request once', () => {
    const v = new SignatureVerifier(SECRET);
    const h = signRequest(SECRET, 'POST', '/v1/update', '{"version":"0.8.0"}');
    expect(v.verify(req(h, '{"version":"0.8.0"}'))).toEqual({ ok: true });
    expect(v.verify(req(h, '{"version":"0.8.0"}'))).toEqual({ ok: false, reason: 'replayed signature' });
  });

  it('refuses another secret, a changed body or path, an old signature and no signature', () => {
    const v = new SignatureVerifier(SECRET);
    expect(v.verify(req(signRequest('b'.repeat(44), 'POST', '/v1/update', '{}'), '{}')).ok).toBe(false);
    expect(v.verify(req(signRequest(SECRET, 'POST', '/v1/update', '{"version":"0.8.0"}'), '{"version":"9.9.9"}')).ok).toBe(false);
    const h = signRequest(SECRET, 'POST', '/v1/other', '');
    expect(v.verify({ ...req(h), path: '/v1/update' }).ok).toBe(false);
    const old = signRequest(SECRET, 'POST', '/v1/update', '', Date.now() - 120_000);
    expect(v.verify(req(old))).toEqual({ ok: false, reason: 'signature expired' });
    expect(v.verify({ method: 'GET', path: '/', body: '', time: undefined, signature: undefined })).toEqual({ ok: false, reason: 'unsigned request' });
    expect(v.verify({ method: 'GET', path: '/', body: '', time: '1.zz', signature: 'x' })).toEqual({ ok: false, reason: 'malformed signature' });
  });
});

describe('updater HTTP API', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let service: UpdaterService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tagave-updater-srv-'));
    await writeFile(join(dir, '.env'), 'TAGAVE_ROLE=all\nTAGAVE_VERSION=0.7.0\n');
    service = new UpdaterService({
      installDir: dir,
      appSecret: SECRET,
      version: '0.7.0',
      // a docker that cannot do anything: an update fails at preflight
      docker: async (args) => (args.join(' ') === 'compose config --services' ? { code: 0, stdout: 'postgres\napp\nupdater\n', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
      app: { health: async () => ({ ok: false, detail: 'down' }), versions: async () => null },
      config: { ...DEFAULT_CONFIG, selfUpdate: false },
    });
    server = service.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await service.idle();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body = '', secret = SECRET) =>
    fetch(`${base}${path}`, { method, headers: signRequest(secret, method, path, body), ...(body ? { body } : {}) });

  it('refuses unsigned and wrongly signed calls', async () => {
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
    expect((await call('GET', '/v1/status', '', 'c'.repeat(44))).status).toBe(401);
  });

  it('reports its status, the configured version and the services an update restarts', async () => {
    const res = await call('GET', '/v1/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '0.7.0', configuredVersion: '0.7.0', role: 'all', services: ['postgres', 'app'], run: null });
  });

  it('starts a run, keeps its state on disk, and refuses a bad version', async () => {
    expect((await call('POST', '/v1/update', '{"version":"latest"}')).status).toBe(400);
    const res = await call('POST', '/v1/update', '{"version":"0.8.0"}');
    expect(res.status).toBe(202);
    await service.idle();
    const state = JSON.parse(await readFile(join(dir, STATE_DIR, 'state.json'), 'utf8')) as UpdateRun;
    expect(state.status).toBe('failed');
    expect(state.target).toBe('0.8.0');
    const status = (await (await call('GET', '/v1/status')).json()) as { run: UpdateRun };
    expect(status.run.id).toBe(state.id);
  });

  it('marks a run that was cut off as interrupted when it starts again', async () => {
    const run = newRun('r1', '0.7.0', '0.8.0', new Date());
    run.steps[4]!.status = 'running';
    run.backup = '/backups/x.pgdump';
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(join(dir, STATE_DIR, 'state.json'), JSON.stringify(run));
    await service.load();
    const status = (await (await call('GET', '/v1/status')).json()) as { run: UpdateRun };
    expect(status.run.status).toBe('interrupted');
    expect(status.run.reason).toMatch(/Restart the app, then the workers.*\/backups\/x\.pgdump/);
  });
});

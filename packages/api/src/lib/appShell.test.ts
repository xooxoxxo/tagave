/**
 * No HTML page of tagave is ever framed: the index fastify-static serves at
 * "/", the history-mode fallback for any deep link (the consent page in any
 * letter case included) all carry X-Frame-Options and frame-ancestors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWebApp, withFrameAncestorsNone } from './appShell.js';

describe('app shell framing', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mct1-shell-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
    app = Fastify({ logger: false });
    await registerWebApp(app, dir);
    app.get('/api/v1/thing', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['/', '/index.html', '/connect/consent?request=x', '/CONNECT/consent?request=x', '/Connect/Consent', '/albums'])('%s is never framed', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  });

  it('leaves scripts and JSON alone', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['x-frame-options']).toBeUndefined();
    const json = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    expect(json.headers['x-frame-options']).toBeUndefined();
  });

  it('merges frame-ancestors into a CSP that is already set', () => {
    expect(withFrameAncestorsNone(undefined)).toBe("frame-ancestors 'none'");
    expect(withFrameAncestorsNone("default-src 'self'; img-src *")).toBe("default-src 'self'; img-src *; frame-ancestors 'none'");
    expect(withFrameAncestorsNone("default-src 'self'; frame-ancestors https://x.example")).toBe("default-src 'self'; frame-ancestors 'none'");
  });
});

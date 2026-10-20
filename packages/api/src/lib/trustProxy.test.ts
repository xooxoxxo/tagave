/**
 * TRUST_PROXY decides which hop names the client (request.ip) for every
 * per-address limit, and the address Better Auth sees (CLIENT_IP_HEADER):
 * a forged X-Forwarded-For from a peer that is not a trusted proxy is
 * ignored, and a client-sent CLIENT_IP_HEADER is replaced. Unset, a proxy
 * on a private network is trusted with no setting at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { CLIENT_IP_HEADER, fastifyTrustProxy, parseTrustProxy } from '@tagave/auth';
import { setClientIpHeader } from '../middleware/auth.js';

/** tagave_default's gateway: a Caddy in its own compose stack reaching the published port arrives from it. */
const GATEWAY = '192.168.80.1';

async function appWith(raw: string | undefined): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: fastifyTrustProxy(parseTrustProxy(raw, () => undefined)) });
  app.addHook('onRequest', setClientIpHeader);
  app.get('/ip', async (request) => ({ ip: request.ip, header: request.headers[CLIENT_IP_HEADER] }));
  await app.ready();
  return app;
}

describe('TRUST_PROXY and the client address', () => {
  const apps: Record<string, FastifyInstance> = {};
  beforeAll(async () => {
    apps['default'] = await appWith(undefined);
    apps['off'] = await appWith('off');
    apps['hop'] = await appWith('1');
    apps['cidr'] = await appWith('172.16.0.0/12');
    apps['proxyNet'] = await appWith('172.21.0.0/16');
    apps['legacy'] = await appWith('true');
  });
  afterAll(async () => {
    for (const a of Object.values(apps)) await a.close();
  });
  const ask = async (app: string, remoteAddress: string, xff?: string, extra: Record<string, string> = {}) =>
    (await apps[app]!.inject({ method: 'GET', url: '/ip', remoteAddress, headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...extra } })).json() as { ip: string; header: string };

  it('unset: a proxy on a private network names the client, and Better Auth gets the same address', async () => {
    expect(await ask('default', '172.18.0.5', '198.51.100.7')).toEqual({ ip: '198.51.100.7', header: '198.51.100.7' });
    expect((await ask('default', '192.168.1.10', '198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('default', '127.0.0.1', '198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('default', '::ffff:10.0.0.3', '198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('unset: what an internet client puts in front of the proxy\'s entry is ignored', async () => {
    expect((await ask('default', '172.18.0.5', '6.6.6.6, 198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('unset: X-Forwarded-For from a public peer is ignored', async () => {
    expect(await ask('default', '203.0.113.9', '198.51.100.1')).toEqual({ ip: '203.0.113.9', header: '203.0.113.9' });
  });

  it('unset: a proxy in another compose stack, arriving from the Docker gateway, names the client', async () => {
    expect(await ask('default', GATEWAY, '198.51.100.7')).toEqual({ ip: '198.51.100.7', header: '198.51.100.7' });
    expect((await ask('default', '172.18.0.3', '198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('an explicit list naming the proxy network does not trust the gateway', async () => {
    expect((await ask('proxyNet', GATEWAY, '198.51.100.7')).ip).toBe(GATEWAY);
    expect((await ask('proxyNet', '172.21.0.2', '198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('off: X-Forwarded-For is ignored from any peer', async () => {
    expect(await ask('off', '172.18.0.5', '198.51.100.1')).toEqual({ ip: '172.18.0.5', header: '172.18.0.5' });
  });

  it('a hop count trusts only the last hop: what the client put in front is ignored', async () => {
    expect((await ask('hop', '172.18.0.2', 'forged, 198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('hop', '172.18.0.2', '198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('a network list trusts only proxies in it: a forged header from any other peer is ignored', async () => {
    expect((await ask('cidr', '172.18.0.2', '198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('cidr', '203.0.113.9', '198.51.100.7')).ip).toBe('203.0.113.9');
    expect((await ask('cidr', '192.168.1.10', '198.51.100.7')).ip).toBe('192.168.1.10');
  });

  it('TRUST_PROXY=true means one hop, never every hop', async () => {
    expect((await ask('legacy', '172.18.0.2', '6.6.6.6, 198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('a client-sent client-address header is replaced', async () => {
    expect((await ask('default', '203.0.113.9', undefined, { [CLIENT_IP_HEADER]: '1.2.3.4' })).header).toBe('203.0.113.9');
  });
});

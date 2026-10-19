/**
 * TRUST_PROXY decides which hop names the client (request.ip) for every
 * per-address limit, and the address Better Auth sees (CLIENT_IP_HEADER):
 * a forged X-Forwarded-For from a peer that is not a trusted proxy is
 * ignored, and a client-sent CLIENT_IP_HEADER is replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { CLIENT_IP_HEADER, fastifyTrustProxy, parseTrustProxy } from '@tagave/auth';
import { setClientIpHeader } from '../middleware/auth.js';

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
    apps['off'] = await appWith(undefined);
    apps['hop'] = await appWith('1');
    apps['cidr'] = await appWith('172.16.0.0/12');
    apps['legacy'] = await appWith('true');
  });
  afterAll(async () => {
    for (const a of Object.values(apps)) await a.close();
  });
  const ask = async (app: string, remoteAddress: string, xff?: string, extra: Record<string, string> = {}) =>
    (await apps[app]!.inject({ method: 'GET', url: '/ip', remoteAddress, headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...extra } })).json() as { ip: string; header: string };

  it('without TRUST_PROXY, X-Forwarded-For is ignored', async () => {
    expect(await ask('off', '203.0.113.9', '198.51.100.1')).toEqual({ ip: '203.0.113.9', header: '203.0.113.9' });
  });

  it('a hop count trusts only the last hop: what the client put in front is ignored', async () => {
    expect((await ask('hop', '172.18.0.2', 'forged, 198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('hop', '172.18.0.2', '198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('a network list trusts only proxies in it: a forged header from any other peer is ignored', async () => {
    expect((await ask('cidr', '172.18.0.2', '198.51.100.7')).ip).toBe('198.51.100.7');
    expect((await ask('cidr', '203.0.113.9', '198.51.100.7')).ip).toBe('203.0.113.9');
  });

  it('TRUST_PROXY=true means one hop, never every hop', async () => {
    expect((await ask('legacy', '172.18.0.2', '6.6.6.6, 198.51.100.7')).ip).toBe('198.51.100.7');
  });

  it('a client-sent client-address header is replaced', async () => {
    expect((await ask('off', '203.0.113.9', undefined, { [CLIENT_IP_HEADER]: '1.2.3.4' })).header).toBe('203.0.113.9');
  });
});

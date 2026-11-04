/**
 * The device routes' guards, without a database: a stream that closes
 * before it is set up leaves nothing behind, device updates are rate limited
 * per person, and a person cannot list more than MAX_DEVICES online.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';

/** The queue's row read when a stream opens: held until the test lets it go. */
let rowGate: { promise: Promise<unknown[]>; resolve: (rows: unknown[]) => void } | null = null;
let queried: () => void = () => undefined;

vi.mock('../db.js', () => {
  const sql = (() => {
    queried();
    return rowGate ? rowGate.promise : Promise.resolve([]);
  }) as unknown as Record<string, unknown>;
  // no LISTEN here: presence stays in this process
  sql['listen'] = () => Promise.reject(new Error('no LISTEN in this test'));
  sql['notify'] = () => Promise.reject(new Error('no NOTIFY in this test'));
  return { getSql: () => sql };
});

const as = (user: string) => ({ 'x-test-user': user, 'x-test-role': 'listener' });
const device = (deviceId: string) => ({ deviceId, name: 'Chrome on Mac', track: null, index: -1, positionMs: 0, playing: false, blocked: false, volume: 1, hidden: false, casting: null });

describe('player device routes: guards', () => {
  let app: FastifyInstance;
  let base: string;
  let presence: typeof import('../lib/playerPresence.js');
  let routes: typeof import('./playerDevices.js');
  let clock = 0;

  beforeEach(async () => {
    presence = await import('../lib/playerPresence.js');
    presence.resetPlayerPresence();
    routes = await import('./playerDevices.js');
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    clock = 0;
    await app.register(routes.createPlayerDeviceRoutes, { prefix: '/api/v1', limiter: new routes.RateLimiter(routes.DEVICE_RATE_PER_SEC, routes.DEVICE_BURST, () => clock) });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    rowGate = null;
    queried = () => undefined;
    await app.close();
    presence.resetPlayerPresence();
    vi.restoreAllMocks();
  });

  it('a stream that closes while it is being set up leaves no subscriber and no ping behind', async () => {
    let release!: (rows: unknown[]) => void;
    rowGate = { promise: new Promise((r) => { release = r; }), resolve: (rows) => release(rows) };
    const reached = new Promise<void>((r) => { queried = r; });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const req = http.get(`${base}/api/v1/me/player/events`, { headers: as('anna') });
    req.on('error', () => undefined);
    await reached;
    // the client goes away before the queue's row is read
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    rowGate.resolve([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(presence.playerPresence().subscriberCount('anna')).toBe(0);
    expect(intervals.mock.calls.filter((c) => c[1] === routes.EVENTS_PING_MS)).toHaveLength(0);
  });

  it('a stream that closes later is cleaned up too', async () => {
    const opened = new Promise<http.IncomingMessage>((resolve) => {
      const req = http.get(`${base}/api/v1/me/player/events`, { headers: as('anna') }, (res) => { resolve(res); res.once('data', () => req.destroy()); });
      req.on('error', () => undefined);
    });
    await opened;
    await new Promise((r) => setTimeout(r, 50));
    expect(presence.playerPresence().subscriberCount('anna')).toBe(0);
  });

  it('limits device updates per person to a burst, then about 4 a second', async () => {
    const put = (user: string) => app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as(user), payload: device('mac-tab-00001') });
    const codes: number[] = [];
    for (let i = 0; i < routes.DEVICE_BURST + 2; i++) codes.push((await put('anna')).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(routes.DEVICE_BURST);
    expect(codes.slice(-2)).toEqual([429, 429]);
    // another person has their own allowance
    expect((await put('ben')).statusCode).toBe(200);
    clock += 1000;
    const after: number[] = [];
    for (let i = 0; i < 5; i++) after.push((await put('anna')).statusCode);
    expect(after).toEqual([200, 200, 200, 200, 429]);
  });

  it('refuses a new device with 429 when MAX_DEVICES are online, and takes one in place of an offline one', async () => {
    for (let i = 0; i < presence.MAX_DEVICES; i++) {
      clock += 1000; // within the rate
      const res = await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as('anna'), payload: device(`tab-${String(i).padStart(8, '0')}`) });
      expect(res.statusCode).toBe(200);
    }
    clock += 1000;
    const full = await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as('anna'), payload: device('tab-one-too-many') });
    expect(full.statusCode).toBe(429);
    expect(full.json().detail).toBe('Too many devices are online');
    await app.inject({ method: 'DELETE', url: '/api/v1/me/player/device/tab-00000004', headers: as('anna') });
    clock += 1000;
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as('anna'), payload: device('tab-one-too-many') })).statusCode).toBe(200);
    expect(presence.playerPresence().deviceCount('anna')).toBe(presence.MAX_DEVICES);
  });

  it('refuses a device id or name of the wrong shape', async () => {
    const bad = [
      { ...device('short') },
      { ...device('tab-<script>-0001') },
      { ...device('tab-00000001'), name: 'x'.repeat(61) },
      { ...device('tab-00000001'), name: '   ' },
    ];
    for (const payload of bad) {
      clock += 1000;
      expect((await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as('anna'), payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/me/player/device/no%20spaces%20here', headers: as('anna') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as('anna'), payload: { deviceId: '../../etc', action: 'play' } })).statusCode).toBe(400);
  });
});

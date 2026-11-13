/**
 * Play in one place against a real database: each person's event stream
 * (GET /me/player/events) hears their devices, the queue's claims and the
 * commands for their devices, through Postgres LISTEN/NOTIFY, and never
 * another person's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

interface Heard { type: string; data: any }

/** An open event stream as `user`, collecting what it hears. */
function open(base: string, user: string): Promise<{ heard: Heard[]; close: () => void; next: (type: string, match?: (d: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const heard: Heard[] = [];
    const waiters: Array<{ type: string; match: (d: any) => boolean; resolve: (d: any) => void }> = [];
    let buf = '';
    const req = http.get(`${base}/api/v1/me/player/events`, { headers: { 'x-test-user': user, 'x-test-role': 'listener' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!type || !data) continue;
          const h = { type, data: JSON.parse(data) };
          heard.push(h);
          for (const w of [...waiters]) if (w.type === type && w.match(h.data)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(h.data); }
        }
      });
      resolve({
        heard,
        close: () => req.destroy(),
        next: (type, match = () => true) => {
          const seen = heard.find((h) => h.type === type && match(h.data));
          if (seen) return Promise.resolve(seen.data);
          return new Promise((r, j) => {
            const w = { type, match, resolve: r };
            waiters.push(w);
            setTimeout(() => j(new Error(`no ${type} event`)), 3000);
          });
        },
      });
    });
    req.on('error', reject);
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('play in one place: events and commands per person', () => {
  let app: FastifyInstance;
  let base: string;
  let sql: any;
  const anna = randomUUID();
  const ben = randomUUID();
  const as = (user: string) => ({ 'x-test-user': user, 'x-test-role': 'listener' });
  const device = (deviceId: string, patch: Record<string, unknown> = {}) => ({
    deviceId, name: 'Chrome on Mac', track: null, index: -1, positionMs: 0, playing: false, blocked: false, volume: 1, hidden: false, casting: null, ...patch,
  });

  beforeAll(async () => {
    const { initDb } = await import('../db.js');
    sql = (await initDb(process.env.TEST_DATABASE_URL!)).client;
    await sql`insert into users (id, email, display_name, password_hash, role) values
      (${anna}, ${`anna-${anna}@t.com`}, 'Anna Devices', 'x', 'owner'), (${ben}, ${`ben-${ben}@t.com`}, 'Ben Devices', 'x', 'listener')`;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createPlayerQueueRoutes } = await import('./playerQueue.js');
    const { createPlayerDeviceRoutes } = await import('./playerDevices.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@t.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createPlayerQueueRoutes, { prefix: '/api/v1' });
    await app.register(createPlayerDeviceRoutes, { prefix: '/api/v1' });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    if (sql) await sql`delete from users where id in (${anna}, ${ben})`;
  });

  it('a stream needs a signed-in person', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/player/events' });
    expect(res.statusCode).toBe(401);
  });

  it('hears the person’s devices, the claim and the commands for their devices; another person hears none of it', async () => {
    const a = await open(base, anna);
    const b = await open(base, ben);
    try {
      await a.next('hello');
      expect((await a.next('devices')).devices).toEqual([]);
      await b.next('devices');

      const mac = `mac-${randomUUID()}`;
      const phone = `phone-${randomUUID()}`;
      expect((await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as(anna), payload: device(mac) })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/me/player/device', headers: as(anna), payload: device(phone, { name: 'Safari on iPhone' }) })).statusCode).toBe(200);
      const listed = await a.next('devices', (d) => d.devices.length === 2);
      expect(listed.devices.map((d: any) => [d.name, d.online])).toEqual([['Chrome on Mac', true], ['Safari on iPhone', true]]);

      // the Mac plays: the queue's claim goes out, and the devices event names it
      const items = [{ id: randomUUID(), origin: 'context' }];
      const put = await app.inject({ method: 'PUT', url: '/api/v1/me/player/queue', headers: as(anna), payload: { items, context: null, index: 0, positionMs: 0, deviceId: mac, mode: 'play' } });
      expect(put.statusCode).toBe(200);
      const revision = put.json().revision;
      expect(await a.next('queue', (q) => q.mode === 'play')).toEqual({ deviceId: mac, revision, mode: 'play' });
      expect((await a.next('devices', (d) => d.active?.deviceId === mac)).active).toEqual({ deviceId: mac, revision });

      // the phone pauses the Mac
      const cmd = await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as(anna), payload: { deviceId: mac, action: 'pause', from: phone } });
      expect(cmd.statusCode).toBe(200);
      expect(await a.next('command')).toEqual({ to: mac, from: phone, action: 'pause', value: null, index: null });

      // a transfer carries the entry and the second
      await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as(anna), payload: { deviceId: phone, action: 'transfer', index: 0, value: 42.5, from: mac } });
      expect(await a.next('command', (c) => c.action === 'transfer')).toMatchObject({ to: phone, index: 0, value: 42.5 });

      // a device that is not online, a malformed command, and another person's device
      expect((await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as(anna), payload: { deviceId: 'nobody-here', action: 'play' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as(anna), payload: { deviceId: mac, action: 'seek' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/me/player/command', headers: as(ben), payload: { deviceId: mac, action: 'play' } })).statusCode).toBe(404);

      // the phone closes: offline at once
      await app.inject({ method: 'DELETE', url: `/api/v1/me/player/device/${phone}`, headers: as(anna) });
      const after = await a.next('devices', (d) => d.devices.some((x: any) => x.deviceId === phone && !x.online));
      expect(after.devices.find((x: any) => x.deviceId === mac).online).toBe(true);

      await new Promise((r) => setTimeout(r, 100));
      expect(b.heard.map((h) => h.type)).toEqual(['hello', 'devices']);
      expect(b.heard[1]!.data).toEqual({ devices: [], active: null });
    } finally {
      a.close();
      b.close();
    }
  });

  it('a new stream starts from the queue’s device', async () => {
    const mac = `mac-${randomUUID()}`;
    await app.inject({ method: 'PUT', url: '/api/v1/me/player/queue', headers: as(anna), payload: { items: [{ id: randomUUID(), origin: 'context' }], context: null, index: 0, positionMs: 0, deviceId: mac, mode: 'play' } });
    const a = await open(base, anna);
    try {
      expect((await a.next('devices')).active?.deviceId).toBe(mac);
    } finally {
      a.close();
    }
  });
});

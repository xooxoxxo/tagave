/**
 * Play in one place: the person's devices and their live events
 * (@tagave/shared › playerDevices for the shapes, lib/playerPresence.ts for
 * the memory behind them).
 *
 *   GET    /api/v1/me/player/events             server-sent events for the signed-in person (the session cookie):
 *                                               hello, then devices (now and on every change), queue (the queue was
 *                                               written), command (for one of their devices). A comment every 15 s
 *                                               keeps proxies open; the browser reconnects by itself.
 *   PUT    /api/v1/me/player/device             this device's state (its heartbeat)
 *   DELETE /api/v1/me/player/device/:deviceId   this device closed
 *   POST   /api/v1/me/player/command            to another device of the person's (404 when it is not online)
 *
 * Everything is per person: a stream hears only its person's devices, and a
 * command reaches only their own.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { playerCommandSchema, playerDeviceStateSchema } from '@tagave/shared';
import { ApiError } from '../middleware/errorHandler.js';
import { getSql } from '../db.js';
import { permission, requirePlayer } from '../lib/playerAccess.js';
import { connectPresenceBus, playerPresence } from '../lib/playerPresence.js';

export const EVENTS_PING_MS = 15_000;

export async function createPlayerDeviceRoutes(fastify: FastifyInstance) {
  const ready = () => connectPresenceBus(getSql() as never, playerPresence(), (err) => fastify.log.warn({ err }, 'LISTEN tagave_player failed; presence stays in this process'));

  fastify.get('/me/player/events', permission('player.use'), async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requirePlayer(request);
    await ready();
    const presence = playerPresence();
    const [row] = await getSql()<Array<{ device_id: string; revision: number | string }>>`select device_id, revision from player_queue_state where user_id = ${user.id}`;
    presence.setActive(user.id, row ? { deviceId: row.device_id, revision: Number(row.revision) } : null);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (frame: string) => {
      try { reply.raw.write(frame); } catch { /* closed; the close handler cleans up */ }
    };
    // a retry hint for the browser's own reconnect, then hello: the devices send their state at once
    write('retry: 2000\n\n');
    write('event: hello\ndata: {}\n\n');
    const unsubscribe = presence.subscribe(user.id, { send: (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) });
    const ping = setInterval(() => write(': ping\n\n'), EVENTS_PING_MS);
    await new Promise<void>((resolve) => {
      request.raw.on('close', () => {
        clearInterval(ping);
        unsubscribe();
        resolve();
      });
    });
  });

  fastify.put('/me/player/device', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const parsed = playerDeviceStateSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Not a device state');
    await ready();
    await playerPresence().publish({ t: 'state', userId: user.id, state: parsed.data, at: Date.now() });
    return { ok: true };
  });

  fastify.delete('/me/player/device/:deviceId', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceId || deviceId.length > 64) throw new ApiError(400, 'Bad Request', 'deviceId');
    await ready();
    await playerPresence().publish({ t: 'leave', userId: user.id, deviceId, at: Date.now() });
    return { ok: true };
  });

  fastify.post('/me/player/command', permission('player.use'), async (request: FastifyRequest) => {
    const user = requirePlayer(request);
    const parsed = playerCommandSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'Bad Request', parsed.error.issues[0]?.message ?? 'Not a command');
    const c = parsed.data;
    if ((c.action === 'seek' || c.action === 'volume') && c.value === undefined) throw new ApiError(400, 'Bad Request', 'value');
    if ((c.action === 'index' || c.action === 'transfer') && c.index === undefined) throw new ApiError(400, 'Bad Request', 'index');
    if (c.action === 'volume' && c.value! > 1) throw new ApiError(400, 'Bad Request', 'value: 0 to 1');
    await ready();
    const presence = playerPresence();
    if (!presence.hasDevice(user.id, c.deviceId)) throw new ApiError(404, 'Not Found', 'That device is not online');
    await presence.publish({
      t: 'command',
      userId: user.id,
      command: { to: c.deviceId, from: c.from ?? null, action: c.action, value: c.value ?? null, index: c.index ?? null },
    });
    return { ok: true };
  });
}

/**
 * Is the music folder there (db › musicFolder.ts, one answer for both):
 *
 *   GET  /api/v1/system/music-folder                 owner: the notice above every page
 *                                                    ({ kind: none | healing | unreachable, paths })
 *
 * And for the updater's self-heal (no session, signed by it instead):
 *
 *   GET  /api/v1/internal/updater/music              { unmounted }: a root's latest scan was stopped by the LIB-5 guard
 *   POST /api/v1/internal/updater/music-heal         { phase: 'start' } | { phase: 'done', ok, reason }: an audit entry
 *                                                    per step; a heal that mounted it queues a scan of each aborted root
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MUSIC_HEAL_REASONS, musicFolderNotice, musicFolderState, musicLooksUnmounted, recordMusicHeal, type MusicHealReason } from '@tagave/db';
import { SIGNATURE_HEADER, SignatureVerifier, TIME_HEADER } from '@tagave/updater/token';
import { ApiError } from '../middleware/errorHandler.js';
import { getAuthHandle } from '../middleware/auth.js';
import { getBoss } from '../boss.js';
import { updaterUrl } from './updater.js';

export async function createMusicFolderRoutes(fastify: FastifyInstance) {
  fastify.get('/system/music-folder', async () => {
    const { sql } = getAuthHandle();
    return musicFolderNotice(await musicFolderState(sql));
  });
}

let verifier: SignatureVerifier | null = null;

function verify(request: FastifyRequest, method: 'GET' | 'POST', body: string): void {
  if (!updaterUrl()) throw new ApiError(404, 'Not Found', 'The updater is not installed on this server');
  const secret = process.env['APP_SECRET'];
  if (!secret) throw new ApiError(500, 'Internal Server Error', 'APP_SECRET is not set');
  verifier ??= new SignatureVerifier(secret);
  const header = (n: string) => {
    const v = request.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const auth = verifier.verify({ method, path: request.url, body, time: header(TIME_HEADER), signature: header(SIGNATURE_HEADER) });
  if (!auth.ok) throw new ApiError(401, 'Unauthorized', auth.reason);
}

type HealBody = { phase: 'start' } | { phase: 'done'; ok: boolean; reason: MusicHealReason };

export function parseHealBody(body: unknown): HealBody | null {
  const b = body as { phase?: unknown; ok?: unknown; reason?: unknown } | null;
  if (b?.phase === 'start') return { phase: 'start' };
  if (b?.phase === 'done' && typeof b.ok === 'boolean' && (MUSIC_HEAL_REASONS as readonly unknown[]).includes(b.reason)) {
    return { phase: 'done', ok: b.ok, reason: b.reason as MusicHealReason };
  }
  return null;
}

/** Registered outside the signed-in routes, next to /internal/updater/versions. */
export async function createMusicFolderInternalRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/updater/music', { logLevel: 'warn' }, async (request) => {
    verify(request, 'GET', '');
    const { sql } = getAuthHandle();
    return { unmounted: musicLooksUnmounted(await musicFolderState(sql)) };
  });

  fastify.post('/internal/updater/music-heal', async (request) => {
    // the updater signs the JSON it sent; parsed and written again it is the same text
    verify(request, 'POST', request.body === undefined ? '' : JSON.stringify(request.body));
    const entry = parseHealBody(request.body);
    if (!entry) throw new ApiError(400, 'Bad Request', 'phase start, or phase done with ok and a known reason');
    const { sql } = getAuthHandle();
    await recordMusicHeal(sql, entry);
    request.log.info({ event: entry.phase === 'start' ? 'music.heal.start' : 'music.heal', ...(entry.phase === 'done' ? { ok: entry.ok, reason: entry.reason } : {}) }, 'music folder self-heal');
    if (entry.phase === 'done' && entry.ok) {
      // mounted again: scan what was aborted now, so the notice clears without waiting for the next poll
      const { unreachable } = await musicFolderState(sql);
      const boss = await getBoss();
      await boss.createQueue('scan.root');
      for (const r of unreachable) await boss.send('scan.root', { scanRootId: r.id, mode: 'full' }, { singletonKey: `scan:${r.id}` });
    }
    return { ok: true };
  });
}

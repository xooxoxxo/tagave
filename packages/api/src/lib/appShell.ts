/**
 * The web app's files and its history-mode fallback, with one rule on top:
 * no HTML page of tagave is ever shown inside a frame (the Music Connections
 * consent page approves with one click; clickjacking it must not be possible
 * from any site, same-site ones included).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { servesAppShell, staticCacheControl } from './staticCache.js';

const FRAME_ANCESTORS = "frame-ancestors 'none'";

/** An existing CSP with frame-ancestors set to 'none' (added, or replacing one already there). */
export function withFrameAncestorsNone(csp: string | undefined): string {
  const directives = (csp ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return [...directives, FRAME_ANCESTORS].join('; ');
}

/** onSend: every text/html response gets X-Frame-Options and frame-ancestors. */
export function denyFramingOnHtml(reply: FastifyReply): void {
  const type = String(reply.getHeader('content-type') ?? '');
  if (!/^text\/html\b/i.test(type)) return;
  reply.header('x-frame-options', 'DENY');
  const existing = reply.getHeader('content-security-policy');
  reply.header('content-security-policy', withFrameAncestorsNone(existing === undefined ? undefined : String(existing)));
}

/** fastify-static for web/dist and the SPA fallback (index.ts; tests build the same). */
export async function registerWebApp(app: FastifyInstance, root: string, onMissing?: (err: unknown) => void): Promise<void> {
  app.addHook('onSend', async (_request, reply, payload) => {
    denyFramingOnHtml(reply);
    return payload;
  });
  try {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      // dist/ carries .br/.gz written at build (web/scripts/precompress.mjs);
      // served by Accept-Encoding, with Vary set by the plugin.
      preCompressed: true,
      cacheControl: false,
      setHeaders: (reply, filePath) => { reply.header('cache-control', staticCacheControl(filePath)); },
    });
  } catch (err) {
    onMissing?.(err);
  }
  // SPA history-mode fallback: deep links (/albums, /queue) must serve the
  // app shell; /api and missing /assets files get JSON 404s.
  app.setNotFoundHandler(async (request, reply) => {
    if (servesAppShell(request.method, request.url)) return reply.sendFile('index.html', root);
    return reply.status(404).send({ status: 404, title: 'Not Found', detail: `Route ${request.method}:${request.url} not found` });
  });
}

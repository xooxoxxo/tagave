/**
 * Request URLs as the request log writes them. A one-time invite or
 * set-password link carries its token in the path, and the Last.fm sign-in
 * comes back with its token and state in the query, and a Music
 * Connections approval with its one-time code; whoever reads the logs must
 * not be able to use them.
 */
const TOKEN_PATH = /(\/invites?\/)[^/?#]+/;
const SECRET_QUERY = new Set(['token', 'state', 'code', 'code_verifier', 'refresh_token', 'access_token', 'client_secret']);

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  const path = (q < 0 ? url : url.slice(0, q)).replace(TOKEN_PATH, '$1[redacted]');
  if (q < 0) return path;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const key of [...params.keys()]) if (SECRET_QUERY.has(key.toLowerCase())) params.set(key, '[redacted]');
  return `${path}?${params.toString()}`;
}

/** Fastify's own request serializer, with the URL redacted. */
export function requestSerializer(req: {
  method: string; url: string; version?: string | undefined; host?: string | undefined; hostname?: string | undefined;
  ip?: string | undefined; socket?: { remotePort?: number | undefined } | undefined;
}): { method: string; url: string; version?: string; host?: string; remoteAddress?: string; remotePort?: number } {
  const host = req.host ?? req.hostname;
  const port = req.socket?.remotePort;
  return {
    method: req.method,
    url: redactUrl(req.url),
    ...(req.version !== undefined ? { version: req.version } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(req.ip !== undefined ? { remoteAddress: req.ip } : {}),
    ...(port !== undefined ? { remotePort: port } : {}),
  };
}

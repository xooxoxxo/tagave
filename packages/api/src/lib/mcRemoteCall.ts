/**
 * One authenticated request to a linked app (Music Connections, tagave as a
 * client) outside the pull: the wantlist decision. It goes where the pull's
 * requests go and the same way: an endpoint the link's manifest names,
 * pinned to the link's origin and the allow-list (@tagave/core/mc › pinned),
 * carried by the checked, address-pinned transport (rfetch), with the
 * link's sealed access token, refreshed once when it is stale or refused.
 *
 * Tokens are opened only in memory and never logged or put in an error.
 */
import type postgres from 'postgres';
import { refreshLinkTokensLocked } from '@tagave/db';
import { ManifestSchema } from 'music-connections';
import { endpointsOf, expiryFrom, openTokens, pinned, readJson, rfetch, sealTokens, type LinkTokens } from '@tagave/core/mc';

type Sql = postgres.Sql;

export interface RemoteLink {
  id: string;
  remote_url: string;
  manifest: unknown;
  client_id: string;
  sealed_tokens: string;
  state: string;
}

export type RemoteCallResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; reason: 'needs_reapproval' | 'refused' | 'unreachable' };

const REFRESH_SKEW_MS = 30_000;

class RefreshRefused extends Error {}

/**
 * A fresh pair, one refresher at a time per link (refreshLinkTokensLocked,
 * shared with the pull): when another refresher was first, its newer pair
 * is used and no refresh token is spent twice. Null when the issuer refused
 * or the link changed.
 */
async function refresh(sql: Sql, link: RemoteLink, tokenUrl: string, held: { sealed: string; tokens: LinkTokens }, appSecret: string): Promise<{ sealed: string; tokens: LinkTokens } | null> {
  const t = held.tokens;
  if (!t.refresh_token) return null;
  let r: { sealed: string; refreshed: boolean } | null;
  try {
    r = await refreshLinkTokensLocked(sql, { id: link.id, remoteUrl: link.remote_url }, held.sealed, async () => {
      const res = await rfetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: link.client_id, client_secret: t.client_secret }).toString(),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RefreshRefused();
      }
      const j = (await readJson(res)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof j.access_token !== 'string' || !j.access_token) throw new RefreshRefused();
      return sealTokens({
        ...t,
        access_token: j.access_token,
        refresh_token: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : t.refresh_token,
        access_expires_at: expiryFrom(j.expires_in),
      }, appSecret);
    });
  } catch (e) {
    if (e instanceof RefreshRefused) return null;
    throw e;
  }
  if (!r) return null;
  const tokens = openTokens(r.sealed, appSecret);
  return tokens ? { sealed: r.sealed, tokens } : null;
}

/**
 * POST `body` (JSON) to `<the capability's feed>/<suffix>` at the link's
 * remote. The URL is built from the manifest and pinned to the link's origin.
 */
export async function postToLinkedApp(
  sql: Sql,
  link: RemoteLink,
  capability: 'wantlist-suggestions',
  suffix: string,
  body: unknown,
  appSecret: string,
): Promise<RemoteCallResult> {
  if (link.state !== 'active') return { ok: false, status: null, reason: 'needs_reapproval' };
  const tok = openTokens(link.sealed_tokens, appSecret);
  if (!tok) return { ok: false, status: null, reason: 'needs_reapproval' };
  let url: string;
  let tokenUrl: string;
  try {
    const manifest = ManifestSchema.parse(link.manifest);
    const origin = new URL(link.remote_url).origin;
    const endpoints = endpointsOf(manifest, origin);
    const feed = endpoints.feeds[capability];
    if (!feed) return { ok: false, status: null, reason: 'refused' };
    url = pinned(`${feed.replace(/\/+$/, '')}/${suffix}`, origin);
    tokenUrl = endpoints.token;
  } catch {
    return { ok: false, status: null, reason: 'unreachable' };
  }
  let held = { sealed: link.sealed_tokens, tokens: tok };
  try {
    const exp = Date.parse(held.tokens.access_expires_at);
    if (Number.isFinite(exp) && exp - REFRESH_SKEW_MS < Date.now()) {
      const next = await refresh(sql, link, tokenUrl, held, appSecret);
      if (!next) return { ok: false, status: null, reason: 'needs_reapproval' };
      held = next;
    }
    const send = (t: LinkTokens) => rfetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${t.access_token}` },
      body: JSON.stringify(body),
    });
    let res = await send(held.tokens);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => undefined);
      const next = await refresh(sql, link, tokenUrl, held, appSecret);
      if (!next) return { ok: false, status: 401, reason: 'needs_reapproval' };
      held = next;
      res = await send(held.tokens);
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, reason: res.status === 401 ? 'needs_reapproval' : 'refused' };
  } catch {
    // LinkError (address, redirect), timeout, network: one answer, no detail
    return { ok: false, status: null, reason: 'unreachable' };
  }
}

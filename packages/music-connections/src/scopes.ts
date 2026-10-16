/**
 * Scope rules, for both sides of a link.
 *
 * Provider: an authorize request's `scope` is space-separated; every scope in
 * it is one the provider offers (providerScopes) or `offline_access`; none is
 * repeated; at least one is a capability scope (offline_access alone grants
 * nothing); `openid` is refused (no ID tokens are issued).
 *
 * Client: ask only for what both sides share, `wantlist-suggestions:write`
 * only alongside reading wantlist suggestions, and offline_access (for a
 * refresh token) only next to at least one capability scope. A capability the
 * remote starts offering later is never granted silently.
 */
import { readScope, type Capability } from "./capabilities.js";
import type { Manifest } from "./schemas.js";

export const OFFLINE_ACCESS = "offline_access";
export const OPENID = "openid";
export const WANTLIST_WRITE = "wantlist-suggestions:write";

/** The scopes a provider offers: `<capability>:read` for each it provides, and the wantlist write scope when it provides wantlist suggestions. */
export function providerScopes(provides: readonly Capability[]): string[] {
  const scopes = provides.map(readScope);
  if (provides.includes("wantlist-suggestions")) scopes.push(WANTLIST_WRITE);
  return scopes;
}

export type ScopeCheck = { ok: true; scopes: string[] } | { ok: false; reason: string };

/**
 * An authorize request's `scope`, checked against what the provider offers.
 * On success the scopes come back in `offered` order, offline_access last.
 * `reason` is safe to show the client (at most 200 characters of its input).
 */
export function parseScopeRequest(raw: string | undefined | null, offered: readonly string[]): ScopeCheck {
  const list = (raw ?? "").split(" ").filter(Boolean);
  if (list.includes(OPENID)) return { ok: false, reason: "openid is not offered" };
  if (new Set(list).size !== list.length) return { ok: false, reason: "a scope is repeated" };
  const unknown = list.filter((s) => s !== OFFLINE_ACCESS && !offered.includes(s));
  if (unknown.length > 0) return { ok: false, reason: `not offered: ${unknown.join(" ").slice(0, 200)}` };
  if (!list.some((s) => s !== OFFLINE_ACCESS)) return { ok: false, reason: "ask for at least one capability scope" };
  return { ok: true, scopes: [...offered.filter((s) => s !== OFFLINE_ACCESS && list.includes(s)), ...(list.includes(OFFLINE_ACCESS) ? [OFFLINE_ACCESS] : [])] };
}

type Provides = Pick<Manifest, "provides">;

/** Capabilities `consumes` lists that `remote` provides, in `consumes` order. */
export function sharedCapabilities(remote: Provides, consumes: readonly Capability[]): Capability[] {
  return consumes.filter((cap) => typeof remote.provides[cap] === "string");
}

/** The scopes a client asks `remote` for; [] when nothing is shared (never a lone offline_access). */
export function linkScopes(remote: Provides, consumes: readonly Capability[]): string[] {
  const caps = sharedCapabilities(remote, consumes);
  if (caps.length === 0) return [];
  const scopes = caps.map(readScope);
  if (caps.includes("wantlist-suggestions")) scopes.push(WANTLIST_WRITE);
  scopes.push(OFFLINE_ACCESS);
  return scopes;
}

/** Granted scopes without offline_access (what a link stores). */
export function capabilityScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s && s !== OFFLINE_ACCESS);
}

/** Capabilities to pull: consumed, provided by the remote, and `<cap>:read` granted. */
export function pullableCapabilities(remote: Provides, granted: readonly string[], consumes: readonly Capability[]): Capability[] {
  return sharedCapabilities(remote, consumes).filter((cap) => granted.includes(readScope(cap)));
}

/** Capabilities the client could pull but the person never granted: "available, re-link to grant". */
export function availableUngranted(remote: Provides, granted: readonly string[], consumes: readonly Capability[]): Capability[] {
  return sharedCapabilities(remote, consumes).filter((cap) => !granted.includes(readScope(cap)));
}

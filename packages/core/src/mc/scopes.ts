/**
 * Which scopes tagave asks a remote for, and which capabilities it pulls
 * (spec §2 Scopes, §5 Scope missing / Manifest change).
 *
 * Only capabilities tagave consumes that the remote provides are asked for:
 * `<capability>:read` each, `wantlist-suggestions:write` only alongside
 * reading wantlist suggestions (Accept / Dismiss goes back to the remote),
 * and `offline_access` (for a refresh token) only next to at least one
 * capability scope. A capability the remote starts offering later is never
 * granted silently: it shows as "available, re-link to grant".
 */
import { readScope, type Capability, type Manifest } from 'music-connections';
import { TAGAVE_CONSUMES } from './allowlist.js';

export const OFFLINE_ACCESS = 'offline_access';
export const WANTLIST_WRITE = 'wantlist-suggestions:write';

/** Capabilities tagave consumes that `remote` provides, in tagave's order. */
export function sharedCapabilities(remote: Pick<Manifest, 'provides'>, consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] {
  return consumes.filter((cap) => typeof remote.provides[cap] === 'string');
}

/** The scope string's parts for linking to `remote`; [] when nothing is shared. */
export function linkScopes(remote: Pick<Manifest, 'provides'>, consumes: readonly Capability[] = TAGAVE_CONSUMES): string[] {
  const caps = sharedCapabilities(remote, consumes);
  if (caps.length === 0) return [];
  const scopes = caps.map(readScope);
  if (caps.includes('wantlist-suggestions')) scopes.push(WANTLIST_WRITE);
  scopes.push(OFFLINE_ACCESS);
  return scopes;
}

/** Granted scopes without offline_access (what a link stores). */
export function capabilityScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s && s !== OFFLINE_ACCESS);
}

/** Capabilities to pull: tagave consumes them, the remote provides them, and `<cap>:read` was granted. */
export function pullableCapabilities(remote: Pick<Manifest, 'provides'>, granted: readonly string[], consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] {
  return sharedCapabilities(remote, consumes).filter((cap) => granted.includes(readScope(cap)));
}

/** Capabilities tagave could pull but the person never granted: "available, re-link to grant". */
export function availableUngranted(remote: Pick<Manifest, 'provides'>, granted: readonly string[], consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] {
  return sharedCapabilities(remote, consumes).filter((cap) => !granted.includes(readScope(cap)));
}

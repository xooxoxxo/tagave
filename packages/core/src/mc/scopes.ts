/**
 * Which scopes tagave asks a remote for, and which capabilities it pulls
 * (spec §2 Scopes, §5 Scope missing / Manifest change). The rules are the
 * package's (scopes.ts there); these default the consumed capabilities to
 * what tagave reads.
 */
import {
  availableUngranted as mcAvailableUngranted,
  linkScopes as mcLinkScopes,
  pullableCapabilities as mcPullableCapabilities,
  sharedCapabilities as mcSharedCapabilities,
  type Capability,
  type Manifest,
} from 'music-connections';
import { TAGAVE_CONSUMES } from './allowlist.js';

export { OFFLINE_ACCESS, WANTLIST_WRITE, capabilityScopes } from 'music-connections';

type Provides = Pick<Manifest, 'provides'>;

/** Capabilities tagave consumes that `remote` provides, in tagave's order. */
export const sharedCapabilities = (remote: Provides, consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] => mcSharedCapabilities(remote, consumes);

/** The scope string's parts for linking to `remote`; [] when nothing is shared. */
export const linkScopes = (remote: Provides, consumes: readonly Capability[] = TAGAVE_CONSUMES): string[] => mcLinkScopes(remote, consumes);

/** Capabilities to pull: tagave consumes them, the remote provides them, and `<cap>:read` was granted. */
export const pullableCapabilities = (remote: Provides, granted: readonly string[], consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] =>
  mcPullableCapabilities(remote, granted, consumes);

/** Capabilities tagave could pull but the person never granted: "available, re-link to grant". */
export const availableUngranted = (remote: Provides, granted: readonly string[], consumes: readonly Capability[] = TAGAVE_CONSUMES): Capability[] =>
  mcAvailableUngranted(remote, granted, consumes);

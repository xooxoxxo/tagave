/**
 * Music Connections, tagave's side as a client (spec §2, §4 Consumer side):
 * the host allow-list (shared with the provider), outbound requests pinned to
 * a linked remote's origin, scope derivation and sealed tokens. The linking
 * routes (api) and the pull job (worker) both use it.
 */
export * from './allowlist.js';
export * from './remote.js';
export * from './scopes.js';
export * from './tokens.js';

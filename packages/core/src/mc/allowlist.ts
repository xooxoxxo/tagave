/**
 * Music Connections host allow-list (spec §2, §5 Security): which hosts
 * tagave talks to, as a provider (the redirect URIs a client may register,
 * api › routes/connect.ts) and as a client (the remotes a person may link,
 * their auth endpoints and feeds). The rules are the protocol's own, from the
 * music-connections package (hosts.ts there); this file adds what tagave
 * serves and reads.
 */
export { isAllowedRedirect, isAllowedRegistration, isAllowedRemote, isPrivateHost, parseTrustedHosts } from 'music-connections';

/** What tagave serves to a linked app, and what it reads from one. */
export const TAGAVE_PROVIDES = ['ratings', 'collection', 'listens', 'identity'] as const;
export const TAGAVE_CONSUMES = ['critic-scores', 'identity', 'wantlist-suggestions'] as const;

export const CAPABILITIES = ["critic-scores", "ratings", "collection", "listens", "identity", "wantlist-suggestions"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const readScope = (c: Capability) => `${c}:read`;
export const SCOPES = [...CAPABILITIES.map(readScope), "wantlist-suggestions:write"] as const;
export const isCapability = (s: string): s is Capability => (CAPABILITIES as readonly string[]).includes(s);
/** The protocol a manifest names, and the tag in every User-Agent. */
export const PROTOCOL = "music-connections/1";
/** The User-Agent every outbound request sends: `<service>/<version> (music-connections/1)`. */
export const userAgentFor = (service: string, version: string): string => `${service}/${version} (${PROTOCOL})`;

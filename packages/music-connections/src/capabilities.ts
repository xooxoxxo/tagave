export const CAPABILITIES = ["critic-scores", "ratings", "collection", "listens", "identity", "wantlist-suggestions"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const readScope = (c: Capability) => `${c}:read`;
export const SCOPES = [...CAPABILITIES.map(readScope), "wantlist-suggestions:write"] as const;
export const isCapability = (s: string): s is Capability => (CAPABILITIES as readonly string[]).includes(s);

# Changelog

## 0.2.0 (2026-10-16)

The protocol rules that each service had copied now live here, as small pure functions with tests.

### Added

- `scopes`: `providerScopes`, `parseScopeRequest` (offered scopes only, no repeats, `offline_access` only alongside a capability scope, `openid` refused), and the client-side `linkScopes`, `sharedCapabilities`, `pullableCapabilities`, `availableUngranted`, `capabilityScopes`.
- `hosts`: `isAllowedRedirect`, `isAllowedRegistration` (exactly one redirect URI), `isAllowedRemote`, `isPrivateHost`, `parseTrustedHosts`, `canonicalHttpUrl`.
- `address`: `classifyAddress`, `addressAllowed`, `checkResolvedAddresses`, `isLiteralLoopback`, `isTrustedName`, and a pure IP parser (`ipVersion`, `v4Bytes`, `v6Groups`).
- `origin`: `remoteOrigin`, `pinToOrigin`, `endpointsOf`, `revokeUrlFor`, `manifestUrl`, `MANIFEST_PATH`.
- `cursor`: `parseSince` (400 or 410) and `feedLimit`; `CURSOR_ID_BIGINT`, `CURSOR_ID_UUID`.
- `oauth`: `bearerToken`, `isPkceChallenge`, `isPkceVerifier`, `isLookupLength`.
- `limits`: named constants for token, client, state, cursor, URL, body-size and timeout limits.
- `LinkError` and `networkReason` (log-safe failure reasons), `readCapped`, `PROTOCOL`, `userAgentFor`.
- `music-connections/node`: `pinnedFetch`, `resolveTarget`, `nodeTransport`, `pinnedLookup`, `systemResolver`.

### Changed

- The package builds to `dist` (`tsc -b`, also on `prepare`); `exports` give types and code from `dist`, and only `dist` is published.
- Dependency ranges accept zod 3.25+ or 4, TypeScript 5.9 or 7, and vitest 2 or 5.
- `MAX_FEED_PAGE_BYTES` moved to `limits` (still exported from the package root).
- `isAllowedRedirect` refuses IPv6 literals, `[::1]` included: `localhost` is the loopback name.

## 0.1.0

- Capabilities, scopes and v1 schemas; cursor codec and feed page builder; pull client; conformance suite.

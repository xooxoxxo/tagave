# music-connections

Music Connections v1 is a small open protocol that lets music apps (libraries, players, review aggregators) exchange data per user, by capability, through pull-based change feeds. This package holds the protocol types, zod schemas (exportable as JSON Schema), the cursor codec, a feed-page builder, a pull client and a conformance suite.

- Pull only: no webhooks. Consumers poll a cursor-based change feed.
- Per user: a user links their account on one service to their account on another.
- Linking is approved in the browser (OAuth 2.0 authorization code with PKCE), scoped per capability, and revocable.
- Albums are keyed on the MusicBrainz release-group MBID, and every item also carries artist and title so unmatched items stay useful.

## 1. Discovery

Each service serves, unauthenticated, `GET /.well-known/music-connections`:

```json
{
  "protocol": "music-connections/1",
  "service": "example-service",
  "version": "1.0.0",
  "auth": { "authorize": "/connect/authorize", "token": "/connect/token", "register": "/connect/register" },
  "provides": { "critic-scores": "/mc/v1/critic-scores", "identity": "/mc/v1/identity" },
  "consumes": ["ratings", "collection", "identity"]
}
```

`provides` maps each capability the service serves to the path of its feed. `consumes` lists capabilities it can read from others. Two services exchange data only where one side's `provides` meets the other's `consumes`. Paths may be absolute paths on the same origin or absolute http(s) URLs. Unknown capability names are ignored.

## 2. Linking

1. The user gives the consumer the provider's base URL (for example `https://music.example`).
2. The consumer fetches the manifest and registers itself as an OAuth client at `auth.register` (client name, redirect URI). A provider accepts registration only from hosts on its allow-list: by default loopback and private-network address ranges. A public host needs HTTPS and an explicit administrator "trust this service" setting on the provider.
3. The consumer redirects the user to `auth.authorize` using the authorization code flow with PKCE (S256 only). The user signs in if needed and sees a consent screen naming the client, its host and the requested scopes.
4. The code is exchanged at `auth.token` for an access token (1 hour) and a refresh token. Refresh tokens rotate on every use; reuse of a rotated refresh token revokes the whole token family.
5. Because the protocol is pull-only, each direction needs its own token. After approval a provider may offer to "link back", which runs the same flow in the other direction. Each direction is revocable independently.

### Scopes

Scopes are per capability and verb:

`critic-scores:read`, `ratings:read`, `collection:read`, `listens:read`, `identity:read`, `wantlist-suggestions:read`, `wantlist-suggestions:write`.

A feed request whose token lacks the matching scope is refused with `403`.

### Tokens and transport

- Tokens are opaque random strings. Providers store only hashes; clients store tokens sealed.
- Tokens never appear in logs, URLs or error messages.
- Requests send `Authorization: Bearer <token>` and `User-Agent: <service>/<version> (music-connections/1)`.
- Plain HTTP is acceptable only on allow-listed private networks. Public hosts use HTTPS.
- Providers should rate-limit per token (for example 60 requests per minute) and answer `429` or `503` with `Retry-After`.

## 3. Feed contract

Every capability exposes the same feed:

```
GET <provides[capability]>?since=<cursor>&limit=500
Authorization: Bearer <token>

200 { "items": [ { "key": "...", "op": "upsert" | "delete", "updated_at": "<ISO 8601>", "data": { ... } | null } ],
      "next": "<cursor>", "more": true | false }
```

- Feeds contain only the authenticated user's data.
- The cursor is opaque to consumers. Omit `since` for a full snapshot. Page through by sending back `next` until `more` is `false`. If a page is empty, `next` echoes the cursor you sent.
- `key` identifies the item within the capability. `op: "delete"` is a tombstone and has `data: null`.
- Tombstones are kept for 90 days. A cursor older than that gets `410 Gone`; the consumer discards its cursor, re-reads a full snapshot and reconciles by key.
- A malformed cursor gets `400`. A missing or invalid token gets `401`.
- Consumers skip items that fail validation instead of failing the whole feed. Unknown fields are ignored and dropped, as are unknown capabilities.
- Every `data` object nests the album reference under `album`: `{ "rg_mbid": "<uuid>" | null, "release_mbid"?: "<uuid>", "discogs_master_id"?: <int>, "discogs_release_id"?: <int>, "artist": "...", "title": "..." }`. Capability fields sit beside `album`, not inside it. A complete `ratings` item:

```json
{
  "key": "rating-42",
  "op": "upsert",
  "updated_at": "2026-10-15T10:00:00.000Z",
  "data": {
    "album": { "rg_mbid": "11111111-2222-4333-8444-555555555555", "artist": "Example Artist", "title": "Example Album" },
    "rating": 8,
    "rating_raw": "4",
    "scale": "0-5",
    "favorite": false,
    "rated_at": "2026-10-01T00:00:00Z"
  }
}
```
- Each capability publishes its JSON Schema at `/mc/v1/schema/<capability>.json`, unauthenticated.

### Capabilities

| Capability | Typical direction | `data` fields (beyond the album reference) |
|---|---|---|
| `critic-scores` | review service to library | `aggregate { score, tier, review_count }`; `reviews [{ source, score, score_raw, url, published_at }]`; `critic_ratings [{ outlet, score, score_raw }]`. Scores are 0 to 10 plus the raw string. No review text. |
| `ratings` | library to review service | `rating` (0 to 10), `rating_raw`, `scale` (for example a 0 to 5 scale mapped times two), `favorite`, `rated_at` |
| `collection` | library to review service | `formats [{ kind: vinyl, cd, cassette, digital or other; detail? }]`, `acquired_at?` |
| `listens` | library to review service | daily aggregate per album: `date` (`YYYY-MM-DD`), `count`, `formats []` |
| `identity` | both | `local_key`, `provenance` (`manual`, `embedded` or `auto`), `confidence` (0 to 1) |
| `wantlist-suggestions` | review service to library | `reason` (a human sentence), `score` (0 to 10 or null), `suggested_at` |

Direction is a convention, not a rule: any service may provide or consume any capability.

### Wantlist decisions

With scope `wantlist-suggestions:write` a consumer reports the user's choice:

```
POST <provides["wantlist-suggestions"]>/<key>/decision
Content-Type: application/json

{ "decision": "accepted" | "dismissed" }
```

The provider stops suggesting that album and may treat a dismissal as a negative taste signal.

### Identity rules (recommended for consumers)

- An incoming `identity` item with provenance `manual` or `embedded` and confidence of at least 0.9 may fill a gap, where the local item has no MBID yet.
- Anything else, or any disagreement with an existing local match, should become a suggestion in a local review queue showing both sides' evidence.
- Never overwrite an existing local match.

### Safety rules for consumers

Validate every inbound item against its schema. URLs must be absolute http(s) URLs with a host, or same-origin absolute paths. Text is length-capped. Never render inbound text as HTML.

## 4. Versioning

- Within `/mc/v1`, changes are additive only: new optional fields and new capabilities. Consumers ignore and drop what they do not know.
- A breaking change ships as `/mc/v2` together with a new `protocol` value in the manifest.
- A service may re-read a peer's manifest periodically. Newly advertised capabilities should never be granted silently; they need a fresh approval.

## 5. This package

```ts
import {
  CAPABILITIES, ManifestSchema, FeedPageSchema, CAPABILITY_DATA, capabilityJsonSchema,
  encodeCursor, decodeCursor, CursorError, buildFeedPage, pull, NeedsReapproval, runConformance,
} from "music-connections";
```

- `ManifestSchema`, `FeedPageSchema(dataSchema)`, `CAPABILITY_DATA[capability]`: zod (v4 API) schemas.
- `capabilityJsonSchema(capability)`: JSON Schema for `/mc/v1/schema/<capability>.json`.
- `encodeCursor` / `decodeCursor`: cursor codec over `(changed_at, id)`. `decodeCursor` throws `CursorError` on anything malformed, which a server should map to `400`.
- `buildFeedPage(rows, limit)`: pass up to `limit + 1` change rows ordered by `(changed_at, id)`; it builds the page, computes `next` and sets `more`.
- `pull(options, deps)`: consumer loop with paging, one token refresh on `401`, re-snapshot on `410`, `Retry-After` handling, per-item validation and a page cap (`truncated` is set when the cap is hit). `NeedsReapproval` is thrown when the token family is dead.

### Protocol rules

The rules both sides of a link enforce, as small pure functions, so every service applies the same ones:

- Scopes: `providerScopes(provides)` lists what a provider offers. `parseScopeRequest(scope, offered)` checks an authorize request: only offered scopes and `offline_access`, no scope twice, `offline_access` only alongside a capability scope, `openid` refused. On the client side, `linkScopes(remote, consumes)`, `pullableCapabilities` and `availableUngranted`.
- Hosts: `isAllowedRedirect(uri, trustedHosts)` (http(s) on a private, CGNAT or loopback host, or https on a trusted host; canonical form only), `isAllowedRegistration(redirectUris, trustedHosts)` (exactly one allowed redirect URI), `isAllowedRemote(uri, trustedHosts)` (also a DNS name, checked on what it resolves to) and `parseTrustedHosts(setting)`.
- Resolved addresses: `classifyAddress(ip)` (`blocked`, `loopback`, `private` or `public`), `addressAllowed(host, ip, trustedName)` and `checkResolvedAddresses(url, addresses, trustedHosts)`, over addresses the caller already resolved.
- Same origin: `remoteOrigin(input, trustedHosts)`, `pinToOrigin(url, origin, trustedHosts)`, `endpointsOf(manifest, origin, trustedHosts)` (every endpoint a manifest names must sit on its origin) and `revokeUrlFor(tokenUrl, origin, trustedHosts)`.
- Feeds: `parseSince(since, { id })` (400 for a malformed cursor, 410 past the tombstones) and `feedLimit(limit)`.
- Input shapes: `bearerToken(header)`, `isPkceChallenge`, `isPkceVerifier`, `isLookupLength`, and the limits as named constants (`MAX_TOKEN_LENGTH`, `MAX_CURSOR_LENGTH`, `MAX_FEED_LIMIT`, `MAX_MANIFEST_BYTES`, `TOMBSTONE_DAYS` and the rest).
- `readCapped(response, maxBytes)` reads a body with a byte cap. Every rule throws `LinkError`, whose message is a fixed string safe to log.

### Node: the pinned transport

```ts
import { pinnedFetch, resolveTarget, nodeTransport } from "music-connections/node";

const res = await pinnedFetch(url, { headers: { accept: "application/json" } }, {
  trustedPublicHosts: parseTrustedHosts(process.env.MC_TRUSTED_PUBLIC_HOSTS),
  userAgent: userAgentFor("example-service", "1.0.0"),
});
```

`pinnedFetch` checks the URL against `isAllowedRemote`, resolves the host once, checks every address, then connects to that exact address on a fresh socket (Host header and TLS server name unchanged), so DNS rebinding cannot swap the target after the check. A 3xx answer is refused, and every request has a timeout. Pass `resolver` and `transport` to test without a network.

### Run the conformance suite

`runConformance` checks a running server against the rules above: the manifest parses; each provided feed answers `401` without a token and a valid page with one; an invalid `since` cursor gets `400`; following `next` (500 items per page) advances and terminates; the page walk stops after 50 pages and reports a note rather than a failure if data is still advancing; and the schema endpoint returns HTTP 200 with a JSON Schema object.

```ts
import { runConformance } from "music-connections";

const { ok, failures, notes } = await runConformance({
  baseUrl: "https://music.example",
  token: process.env.MC_TEST_TOKEN!, // an access token with read scopes for every provided capability
});
if (notes.length) console.warn(notes.join("\n"));
if (!ok) {
  console.error(failures.join("\n"));
  process.exit(1);
}
```

Pass `fetch` to run against an in-process app without a network, which is how a service can run the suite in its own CI.

## License

MIT

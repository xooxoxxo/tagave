/**
 * The protocol's size, length and time limits, as named constants. Providers
 * and consumers check against these instead of their own copies.
 */

/** Longest URL accepted anywhere: a redirect URI, a remote, a manifest endpoint. */
export const MAX_URL_LENGTH = 2048;

/** Longest bearer, refresh token or authorization code a provider looks up. Longer is refused unread. */
export const MAX_TOKEN_LENGTH = 200;
/** Longest client secret a provider compares. */
export const MAX_CLIENT_SECRET_LENGTH = 200;
/** Longest client_id a provider looks up. */
export const MAX_CLIENT_ID_LENGTH = 100;
/** Longest client_name a registration may carry. */
export const MAX_CLIENT_NAME_LENGTH = 100;
/** Longest OAuth `state` an authorize request may carry. */
export const MAX_STATE_LENGTH = 512;

/** Longest `since` cursor (and `next`) a feed accepts or sends. */
export const MAX_CURSOR_LENGTH = 512;
/** Longest id inside a decoded cursor. */
export const MAX_CURSOR_ID_LENGTH = 200;
/** Most items on one feed page, and the default `limit`. */
export const MAX_FEED_LIMIT = 500;
/** How long tombstones are kept; a cursor older than this is `410 Gone`. */
export const TOMBSTONE_DAYS = 90;

/** Cap on a manifest body, and on the small JSON answers of the token and register endpoints. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** Cap on one feed page body. */
export const MAX_FEED_PAGE_BYTES = 5_000_000;

/** Timeout for a manifest, register, token or revoke request. */
export const REMOTE_TIMEOUT_MS = 10_000;
/** Timeout for one feed page. */
export const FEED_TIMEOUT_MS = 30_000;

/** Access token lifetime (1 hour). */
export const ACCESS_TOKEN_TTL_S = 60 * 60;
/** Refresh token lifetime (90 days). */
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;

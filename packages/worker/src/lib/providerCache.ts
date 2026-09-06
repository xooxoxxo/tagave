/**
 * Raw-ish provider response cache in provider_cache (spec §10.2.8): re-scoring,
 * re-bridging and debugging never re-spend rate limit. Keys never contain
 * credentials. Values are the mapped objects the callers use, so a key
 * carries a mapper version to bust stale shapes.
 */
import type { Sql } from './context.js';

/** Bump when a provider mapper changes shape; old rows simply miss. */
export const CACHE_VERSION = 'v2';

/** seconds; null = never expires (Discogs CC0 data is refreshed on demand only) */
export const TTLs = {
  discogsEntity: null as number | null,
  discogsSearch: 7 * 24 * 3600,
  mbRelease: 30 * 24 * 3600,
  mbUrl: 30 * 24 * 3600,
  mbArtist: 30 * 24 * 3600,
  wikidata: 30 * 24 * 3600,
  // reviews refresh at most weekly (spec REV-1)
  critiquebrainz: 7 * 24 * 3600,
  wikipedia: 7 * 24 * 3600,
  mbRating: 7 * 24 * 3600,
} as const;

/**
 * Discogs Restricted / marketplace / user data must not be persisted
 * (spec §10.2.5): community have/want/rating, prices, videos. Works on both
 * raw payloads and mapped objects (search payloads strip per hit).
 */
export function stripDiscogs<T>(payload: T): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map((x) => stripDiscogs(x));
  const drop = ['community', 'num_for_sale', 'lowest_price', 'blocked_from_sale', 'estimated_weight', 'videos', 'thumb'];
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const k of drop) delete out[k];
  if (Array.isArray(out['results'])) {
    out['results'] = (out['results'] as unknown[]).map((hit) => {
      if (!hit || typeof hit !== 'object') return hit;
      const h = { ...(hit as Record<string, unknown>) };
      delete h['community'];
      return h;
    });
  }
  return out;
}

export interface CacheOptions<T> {
  /** applied to the value before it is stored (and therefore before it is served on a hit) */
  strip?: (raw: T) => unknown;
  /** ignore an existing row and refetch */
  bypass?: boolean;
}

export function cacheKey(...parts: (string | number)[]): string {
  return [CACHE_VERSION, ...parts].join(':');
}

/**
 * Read-through cache. On a hit returns the stored (stripped) value; on a
 * miss calls fn, stores the stripped value, and returns the stripped value
 * too so both paths yield the same shape.
 */
export async function cached<T>(
  sql: Sql,
  provider: string,
  key: string,
  ttlSeconds: number | null,
  fn: () => Promise<T>,
  opts: CacheOptions<T> = {},
): Promise<T> {
  if (!opts.bypass) {
    const rows = await sql`
      select payload from provider_cache
      where provider = ${provider} and cache_key = ${key}
        and (expires_at is null or expires_at > now())
      limit 1` as unknown as Array<{ payload: unknown }>;
    if (rows[0]) return rows[0].payload as T;
  }
  const fresh = await fn();
  const value = (opts.strip ? opts.strip(fresh) : fresh) as T;
  // JSON.stringify writes NUL as the 6-char escape; jsonb rejects it.
  const json = JSON.stringify(value ?? null).replace(/\\u0000/g, '');
  await sql`
    insert into provider_cache (provider, cache_key, payload, fetched_at, expires_at)
    values (${provider}, ${key}, ${json}::jsonb, now(),
            ${ttlSeconds ? sql`now() + make_interval(secs => ${ttlSeconds})` : null})
    on conflict (provider, cache_key) do update set
      payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at`;
  return JSON.parse(json) as T;
}

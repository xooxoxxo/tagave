/**
 * Provider pacer shared across worker processes through provider_state
 * (spec §10.2.1: one limiter per provider, shared by every job). A process-
 * local promise chain serialises calls inside one process; the DB row
 * serialises across processes (g9 file worker + identify worker, api).
 */
import type { Sql } from './context.js';

/** provider_state rows. Discogs has ONE budget whether or not a token is
 * used (token → per-token, else per-IP; all our processes share both). */
export type ProviderName = 'musicbrainz' | 'discogs' | 'wikidata' | 'caa' | 'critiquebrainz' | 'wikipedia' | 'acoustid';

/** Request intervals in ms (spec §10.2.1 headroom under each limit). */
export const PROVIDER_INTERVALS = {
  musicbrainz: 1100,   // 1 req/s
  discogsAuth: 1091,   // 55/min authenticated (limit 60)
  discogsAnon: 2400,   // 25/min unauthenticated
  wikidata: 1000,
  critiquebrainz: 1000, // MetaBrainz etiquette, 1 req/s
  wikipedia: 1000,      // Action API: serial requests, maxlag=5
  acoustid: 340,        // 3 req/s (IDN-5)
} as const;

/**
 * Escalating cooldown. MusicBrainz answers 503 the moment a per-IP window is
 * exceeded and recovers within seconds, so a minute-long freeze per 503 was
 * costing more throughput than the overrun itself: 5 s → 15 s → 45 s.
 * A provider's Retry-After (Discogs 429) always wins when longer.
 */
export function cooldownMsForAttempt(attempt: number, retryAfterMs?: number): number {
  const base = 5_000 * 3 ** Math.max(0, Math.min(attempt, 3) - 1);
  return retryAfterMs ? Math.max(retryAfterMs, base) : base;
}

/** 503 (MusicBrainz) and 429 (Discogs/Wikidata) both mean "back off". */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(503|429)\b|rate limit/i.test(msg);
}

/**
 * MusicBrainz answers 503 "web server is currently busy" under its own load,
 * unrelated to our per-IP budget: that request should simply be retried,
 * while everyone else keeps their 1.1 s cadence. Only a real rate-limit
 * message ("exceeding the allowable rate") earns the shared cooldown.
 */
export function isServerBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /currently busy|try again later/i.test(msg) && !/exceeding|rate limit exceeded/i.test(msg);
}

/**
 * Claim the next slot for a provider and sleep until it arrives. One atomic
 * upsert: the row's next_slot_at is pushed forward by intervalMs from
 * max(previous slot, now, circuit_open_until); the caller gets its own slot
 * time back. Sleep is computed from the server's clock (slot_at - now())
 * so host clock skew cannot shorten the interval.
 */
export async function claimSlot(sql: Sql, provider: ProviderName, intervalMs: number): Promise<void> {
  const secs = intervalMs / 1000;
  const rows = await sql`
    insert into provider_state (provider, window_started_at, requests_used, next_slot_at)
    values (${provider}, now(), 1, now() + make_interval(secs => ${secs}))
    on conflict (provider) do update set
      next_slot_at = greatest(
        coalesce(provider_state.next_slot_at, now()),
        now(),
        coalesce(provider_state.circuit_open_until, now())
      ) + make_interval(secs => ${secs}),
      requests_used = coalesce(provider_state.requests_used, 0) + 1
    returning
      extract(epoch from (next_slot_at - make_interval(secs => ${secs}) - now())) * 1000 as wait_ms
  ` as unknown as Array<{ wait_ms: number | string }>;
  const waitMs = Math.max(0, Math.round(Number(rows[0]?.wait_ms ?? 0)));
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

/** Open the provider's circuit for `ms` (never shortens an existing cooldown). */
export async function openCooldown(sql: Sql, provider: ProviderName, ms: number, reason: string): Promise<void> {
  await sql`
    insert into provider_state (provider, window_started_at, requests_used, circuit_open_until, last_429_at, last_error)
    values (${provider}, now(), 0, now() + make_interval(secs => ${ms / 1000}), now(), ${reason.slice(0, 500)})
    on conflict (provider) do update set
      circuit_open_until = greatest(coalesce(provider_state.circuit_open_until, now()), now() + make_interval(secs => ${ms / 1000})),
      last_429_at = now(),
      last_error = ${reason.slice(0, 500)}
  `;
}

interface PacedOptions {
  /** attempts including the first (default 3) */
  maxAttempts?: number;
  /** runs after every successful call (e.g. inspect rate-limit headers) */
  afterCall?: () => Promise<void> | void;
}

const chains = new Map<ProviderName, Promise<void>>();

/** Optional observer so the worker can log every shared cooldown it opens. */
let onCooldown: ((provider: ProviderName, ms: number, attempt: number, reason: string) => void) | undefined;
export function setCooldownObserver(fn: typeof onCooldown): void { onCooldown = fn; }

/**
 * Serialise + pace + retry a provider call. Rate-limit errors (503/429)
 * open a shared cooldown that every process honours through claimSlot,
 * then retry up to maxAttempts; other errors propagate immediately.
 */
export function paced<T>(
  sql: Sql,
  provider: ProviderName,
  intervalMs: number,
  fn: () => Promise<T>,
  opts: PacedOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const prev = chains.get(provider) ?? Promise.resolve();
  const run = prev.then(async () => {
    for (let attempt = 1; ; attempt++) {
      await claimSlot(sql, provider, intervalMs);
      try {
        const out = await fn();
        await opts.afterCall?.();
        return out;
      } catch (err) {
        if (!isRateLimitError(err)) throw err;
        if (isServerBusyError(err)) {
          // per-request backoff only; the shared cadence stays untouched
          if (attempt >= maxAttempts) throw err;
          await new Promise((r) => setTimeout(r, 2_000 * attempt));
          continue;
        }
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        const ms = cooldownMsForAttempt(attempt, retryAfterMs);
        await openCooldown(sql, provider, ms, (err as Error).message);
        onCooldown?.(provider, ms, attempt, (err as Error).message);
        if (attempt >= maxAttempts) throw err;
        // claimSlot on the next loop waits out the cooldown (server time).
      }
    }
  });
  chains.set(provider, run.then(() => undefined, () => undefined));
  return run;
}

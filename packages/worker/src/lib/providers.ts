/**
 * Provider instances per library settings + the paced call helpers every job
 * uses. Instances are memoised per (contact, token); the pacer state lives in
 * provider_state (see pacer.ts) so all processes share one budget.
 */
import {
  MusicBrainzProvider, DiscogsProvider, WikidataClient, CritiqueBrainzClient, WikipediaClient, AcoustIdClient, openSecret, isSealed,
} from '@liner/core';
import type { WorkerContext } from './context.js';
import { PROVIDER_INTERVALS, openCooldown, paced } from './pacer.js';

export interface LibraryProviderSettings {
  contactString?: string;
  discogsToken?: string;
  /** owner's AcoustID application key (PLT-4); fingerprint lookups need it */
  acoustidKey?: string;
  /** IDN-5 opt-in: the fingerprint sweep runs only when this is on */
  fingerprintingEnabled?: boolean;
}

export interface Providers {
  mb: MusicBrainzProvider;
  discogs: DiscogsProvider;
  wikidata: WikidataClient;
  critiquebrainz: CritiqueBrainzClient;
  wikipedia: WikipediaClient;
  /** present only when the library has an AcoustID key */
  acoustid?: AcoustIdClient;
}

const memo = new Map<string, Providers>();

const warned = new Set<string>();
function warnOnce(ctx: WorkerContext, msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  ctx.logger.warn(msg);
}

/** libraries.settings jsonb → the two keys the providers need. */
export async function libraryProviderSettings(ctx: WorkerContext, libraryId: string): Promise<LibraryProviderSettings> {
  const rows = await ctx.sql`
    select settings->>'contactString' as contact, settings->>'discogsToken' as token,
           settings->>'acoustidKey' as acoustid, (settings->>'fingerprintingEnabled')::boolean as fingerprinting
    from libraries where id = ${libraryId}` as unknown as Array<{
    contact: string | null; token: string | null; acoustid: string | null; fingerprinting: boolean | null;
  }>;
  const out: LibraryProviderSettings = {};
  if (rows[0]?.contact) out.contactString = rows[0].contact;
  if (rows[0]?.fingerprinting) out.fingerprintingEnabled = true;

  // Sealed credentials (PLT-5) open with this host's APP_SECRET; without it a
  // provider simply runs without its key — warned once, never a crash.
  const open = (value: string, name: string, consequence: string): string | undefined => {
    if (!isSealed(value)) return value; // legacy plaintext row (sealed by the api on its next boot)
    const appSecret = process.env.APP_SECRET;
    if (!appSecret) {
      warnOnce(ctx, `APP_SECRET missing on this host; sealed credentials unusable — ${consequence}`);
      return undefined;
    }
    try {
      return openSecret(value, appSecret);
    } catch {
      warnOnce(ctx, `sealed ${name} for library ${libraryId} does not open with this host's APP_SECRET — ${consequence}`);
      return undefined;
    }
  };
  if (rows[0]?.token) {
    const t = open(rows[0].token, 'discogsToken', 'Discogs runs unauthenticated');
    if (t) out.discogsToken = t;
  }
  if (rows[0]?.acoustid) {
    const k = open(rows[0].acoustid, 'acoustidKey', 'fingerprint lookups are skipped');
    if (k) out.acoustidKey = k;
  }
  return out;
}

/** Throws without a contact string: the gateway refuses to call providers
 * until PLT-4 onboarding set one (spec §10.2.3). */
export function getProviders(settings: LibraryProviderSettings): Providers {
  if (!settings.contactString) {
    throw new Error('no contact string configured (PLT-4); refusing provider calls');
  }
  const key = `${settings.contactString}|${settings.discogsToken ?? ''}|${settings.acoustidKey ?? ''}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const userAgent = `Liner/0.1 (+${settings.contactString})`;
  const made: Providers = {
    mb: new MusicBrainzProvider(userAgent),
    discogs: new DiscogsProvider({
      ...(settings.discogsToken ? { token: settings.discogsToken } : {}),
      userAgent,
    }),
    wikidata: new WikidataClient({ userAgent }),
    critiquebrainz: new CritiqueBrainzClient({ userAgent }),
    wikipedia: new WikipediaClient({ userAgent }),
    ...(settings.acoustidKey ? { acoustid: new AcoustIdClient({ apiKey: settings.acoustidKey, userAgent }) } : {}),
  };
  memo.set(key, made);
  return made;
}

export function acoustidCall<T>(ctx: WorkerContext, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'acoustid', PROVIDER_INTERVALS.acoustid, fn);
}

export function discogsIntervalFor(p: DiscogsProvider): number {
  return p.authenticated ? PROVIDER_INTERVALS.discogsAuth : PROVIDER_INTERVALS.discogsAnon;
}

/**
 * Paced Discogs call. Wrap the HTTP call only — put this INSIDE cached() so
 * cache hits do not burn a rate slot. When the response headers say the
 * moving window is nearly spent, open a short shared cooldown.
 */
export function discogsCall<T>(ctx: WorkerContext, providers: Providers, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'discogs', discogsIntervalFor(providers.discogs), fn, {
    afterCall: async () => {
      const rl = providers.discogs.lastRateLimit;
      if (rl && rl.remaining <= 1) {
        await openCooldown(ctx.sql, 'discogs', 30_000, `X-Discogs-Ratelimit-Remaining ${rl.remaining}/${rl.limit}`);
      }
    },
  });
}

export function mbCall<T>(ctx: WorkerContext, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'musicbrainz', PROVIDER_INTERVALS.musicbrainz, fn);
}

export function wikidataCall<T>(ctx: WorkerContext, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'wikidata', PROVIDER_INTERVALS.wikidata, fn);
}

export function critiqueBrainzCall<T>(ctx: WorkerContext, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'critiquebrainz', PROVIDER_INTERVALS.critiquebrainz, fn);
}

export function wikipediaCall<T>(ctx: WorkerContext, fn: () => Promise<T>): Promise<T> {
  return paced(ctx.sql, 'wikipedia', PROVIDER_INTERVALS.wikipedia, fn);
}

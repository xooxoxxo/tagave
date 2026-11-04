/**
 * Similar artists (the similar-artists module): asking ListenBrainz and,
 * with the install's Last.fm API key, Last.fm which artists are similar to
 * one, and merging the two answers. The fetch job (worker) and the routes
 * (api) use it.
 *
 *   ListenBrainz  labs.api.listenbrainz.org/similar-artists/json, by the
 *                 artist's MBID: open MetaBrainz data from listening
 *                 sessions; no key. Its score is a count, so it is scaled
 *                 to 0..1 by the best one.
 *   Last.fm       artist.getSimilar, by the artist's MBID, with the API key
 *                 the owner gave for scrobbling. Its match is 0..1.
 *
 * What leaves the server: the artist's MBID, the install's User-Agent (its
 * contact) and, to Last.fm, the API key. No name, nothing about the person
 * or the library. Every call goes through `pace` (the worker's shared
 * provider pacer). ListenBrainz failing fails the fetch (the job retries);
 * Last.fm failing leaves it out.
 */
import { z } from 'zod';

export const LISTENBRAINZ_SIMILAR_URL = 'https://labs.api.listenbrainz.org/similar-artists/json';
/**
 * The dataset ListenBrainz's own artist pages use: sessions over the
 * longest window (7500 days), at least 10 shared sessions, 100 per artist.
 */
export const LISTENBRAINZ_SIMILAR_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
export const LASTFM_SIMILAR_URL = 'https://ws.audioscrobbler.com/2.0/';

/** A list a week old is fetched again; a failed fetch after a day. */
export const SIMILAR_REFRESH_DAYS = 7;
export const SIMILAR_RETRY_DAYS = 1;
/** How many are kept per artist (the page shows at most 16, the library's first). */
export const SIMILAR_KEEP = 50;

export type SimilarProvider = 'listenbrainz' | 'lastfm';
export type SimilarSource = SimilarProvider;

export interface SimilarDeps {
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** run one HTTP call in the provider's rate limit */
  pace?: <T>(provider: SimilarProvider, fn: () => Promise<T>) => Promise<T>;
  /** for tests: a fake ListenBrainz or Last.fm */
  listenbrainzUrl?: string;
  lastfmUrl?: string;
  timeoutMs?: number;
}

export interface SimilarHit {
  mbid: string | null;
  name: string;
  comment: string | null;
  /** 0..1 within its source */
  score: number;
}

export interface MergedSimilar {
  mbid: string | null;
  name: string;
  comment: string | null;
  /** 0..1, blended */
  score: number;
  sources: SimilarSource[];
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LbAnswer = z.array(z.object({
  artist_mbid: z.string(),
  name: z.string(),
  comment: z.string().nullish(),
  score: z.number(),
}).passthrough());

const LastfmAnswer = z.object({
  similarartists: z.object({
    artist: z.union([
      z.array(z.object({ name: z.string(), mbid: z.string().nullish(), match: z.union([z.string(), z.number()]).nullish() }).passthrough()),
      z.object({ name: z.string(), mbid: z.string().nullish(), match: z.union([z.string(), z.number()]).nullish() }).passthrough(),
    ]).optional(),
  }).passthrough().optional(),
  error: z.number().optional(),
  message: z.string().optional(),
}).passthrough();

/** A name for matching: no accents, no case, no punctuation, "&" as "and", no leading "The". */
export function similarNameKey(name: string): string {
  const s = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
  return s.replace(/ /g, '');
}

/** Whether an artist's list is due: never fetched, a week old, or failed a day ago. */
export function similarDue(check: { fetchedAt: Date | string; error?: string | null } | null | undefined, now = Date.now()): boolean {
  if (!check) return true;
  const days = check.error ? SIMILAR_RETRY_DAYS : SIMILAR_REFRESH_DAYS;
  return new Date(check.fetchedAt).getTime() < now - days * 86_400_000;
}

export class SimilarArtistsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly pace: NonNullable<SimilarDeps['pace']>;

  constructor(private readonly deps: SimilarDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.pace = deps.pace ?? ((_p, fn) => fn());
  }

  /** ListenBrainz's similar artists, best first, scaled to 0..1. An artist it does not know: []. */
  async listenbrainz(mbid: string): Promise<SimilarHit[]> {
    if (!MBID_RE.test(mbid)) return [];
    const q = new URLSearchParams({ artist_mbids: mbid, algorithm: LISTENBRAINZ_SIMILAR_ALGORITHM });
    const url = `${this.deps.listenbrainzUrl ?? LISTENBRAINZ_SIMILAR_URL}?${q.toString()}`;
    const body = await this.pace('listenbrainz', async () => {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': this.deps.userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
      // a dataset without this artist answers 400 or 404: no list, not a failure
      if (res.status === 400 || res.status === 404) return [];
      if (!res.ok) throw new Error(`ListenBrainz similar artists: HTTP ${res.status}`);
      return res.json() as Promise<unknown>;
    });
    const parsed = LbAnswer.safeParse(body);
    if (!parsed.success) throw new Error('ListenBrainz similar artists: unexpected answer');
    const rows = parsed.data.filter((r) => MBID_RE.test(r.artist_mbid) && r.artist_mbid !== mbid && r.name.trim() && r.score > 0);
    const top = Math.max(0, ...rows.map((r) => r.score));
    return rows
      .map((r) => ({ mbid: r.artist_mbid, name: r.name.trim(), comment: r.comment?.trim() || null, score: top > 0 ? r.score / top : 0 }))
      .sort((a, b) => b.score - a.score);
  }

  /** Last.fm's similar artists by MBID, best first. An artist it does not know: []. */
  async lastfm(mbid: string, apiKey: string): Promise<SimilarHit[]> {
    if (!MBID_RE.test(mbid)) return [];
    const q = new URLSearchParams({ method: 'artist.getsimilar', mbid, api_key: apiKey, format: 'json', limit: String(SIMILAR_KEEP), autocorrect: '0' });
    const url = `${this.deps.lastfmUrl ?? LASTFM_SIMILAR_URL}?${q.toString()}`;
    const body = await this.pace('lastfm', async () => {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': this.deps.userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`Last.fm similar artists: HTTP ${res.status}`);
      return res.json().catch(() => null) as Promise<unknown>;
    });
    const parsed = LastfmAnswer.safeParse(body);
    if (!parsed.success) throw new Error('Last.fm similar artists: unexpected answer');
    // 6: the artist is not known; 29: rate limit (the pacer's cooldown)
    if (parsed.data.error === 6) return [];
    if (parsed.data.error === 29) throw new Error('Last.fm similar artists: 429 rate limit');
    if (parsed.data.error !== undefined) throw new Error(`Last.fm similar artists: error ${parsed.data.error}`);
    const raw = parsed.data.similarartists?.artist;
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    return list
      .map((a) => ({ mbid: a.mbid && MBID_RE.test(a.mbid) ? a.mbid : null, name: a.name.trim(), comment: null, score: Math.max(0, Math.min(1, Number(a.match ?? 0) || 0)) }))
      .filter((a) => a.name && a.mbid !== mbid && a.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

/** How much each source weighs when both answered. */
export const SIMILAR_WEIGHTS: Readonly<Record<SimilarSource, number>> = { listenbrainz: 0.6, lastfm: 0.4 };

/**
 * One list from both answers: the same artist by MBID, else by name; its
 * score the weighted sum (a source that does not list it adds nothing).
 * Without a Last.fm answer, ListenBrainz's own order and scores. ListenBrainz
 * names and comments win (MusicBrainz's spelling).
 */
export function mergeSimilar(lb: readonly SimilarHit[], lastfm: readonly SimilarHit[] | null, opts: { exclude?: { mbid?: string | null; name?: string | null }; limit?: number } = {}): MergedSimilar[] {
  const limit = opts.limit ?? SIMILAR_KEEP;
  const excludeKey = opts.exclude?.name ? similarNameKey(opts.exclude.name) : null;
  const both = lastfm !== null;
  const out: MergedSimilar[] = [];
  const byMbid = new Map<string, MergedSimilar>();
  const byName = new Map<string, MergedSimilar>();
  const raw = new Map<MergedSimilar, Partial<Record<SimilarSource, number>>>();
  const add = (h: SimilarHit, source: SimilarSource) => {
    const key = similarNameKey(h.name);
    if (opts.exclude?.mbid && h.mbid === opts.exclude.mbid) return;
    if (excludeKey && key === excludeKey && !h.mbid) return;
    let m = (h.mbid ? byMbid.get(h.mbid) : undefined) ?? (key ? byName.get(key) : undefined);
    // a name match with another MBID is another artist
    if (m && h.mbid && m.mbid && m.mbid !== h.mbid) m = undefined;
    if (!m) {
      m = { mbid: h.mbid, name: h.name, comment: h.comment, score: 0, sources: [] };
      out.push(m);
      raw.set(m, {});
    }
    if (!m.mbid && h.mbid) m.mbid = h.mbid;
    if (m.mbid) byMbid.set(m.mbid, m);
    if (key && !byName.has(key)) byName.set(key, m);
    const scores = raw.get(m)!;
    if ((scores[source] ?? -1) < h.score) scores[source] = h.score;
    if (!m.sources.includes(source)) m.sources.push(source);
  };
  for (const h of lb) add(h, 'listenbrainz');
  for (const h of lastfm ?? []) add(h, 'lastfm');
  for (const m of out) {
    const s = raw.get(m)!;
    m.score = both
      ? SIMILAR_WEIGHTS.listenbrainz * (s.listenbrainz ?? 0) + SIMILAR_WEIGHTS.lastfm * (s.lastfm ?? 0)
      : (s.listenbrainz ?? 0);
    m.score = Math.round(Math.max(0, Math.min(1, m.score)) * 10_000) / 10_000;
    m.sources.sort();
  }
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map(({ m }) => m)
    .slice(0, limit);
}

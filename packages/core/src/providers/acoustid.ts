/**
 * AcoustID lookup (spec IDN-5). One request per fingerprint; the response
 * carries the recording MBIDs and, with `meta=releases releasegroups`, the
 * releases each recording appears on — so an album's release candidates come
 * straight from AcoustID and MusicBrainz is only asked for the releases the
 * caller decides to fetch. Free for non-commercial use with the owner's own
 * application key; ≤ 3 requests/s (paced by the caller).
 */
import { z } from 'zod';

const releaseGroupSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.string().optional(),
}).passthrough();

const releaseSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  country: z.string().optional(),
  track_count: z.number().optional(),
  medium_count: z.number().optional(),
  releasegroup: releaseGroupSchema.optional(),
}).passthrough();

const recordingSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  duration: z.number().optional(),
  releases: z.array(releaseSchema).optional(),
}).passthrough();

const resultSchema = z.object({
  id: z.string(),
  score: z.number(),
  recordings: z.array(recordingSchema).optional(),
}).passthrough();

export const acoustIdResponseSchema = z.object({
  status: z.string(),
  results: z.array(resultSchema).optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).passthrough().optional(),
}).passthrough();

export interface AcoustIdRelease {
  mbid: string;
  releaseGroupMbid?: string;
  title?: string;
  country?: string;
  trackCount?: number;
  mediumCount?: number;
}

export interface AcoustIdRecording {
  /** AcoustID match score for the fingerprint this recording came from (0–1) */
  score: number;
  recordingMbid: string;
  title?: string;
  durationS?: number;
  releases: AcoustIdRelease[];
}

export class AcoustIdError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'AcoustIdError';
  }
  /** 429 (client quota) and 503 (service) both mean "back off", like MusicBrainz's busy replies */
  get isRateLimit(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

export interface AcoustIdClientOptions {
  apiKey: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AcoustIdClient {
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AcoustIdClientOptions) {
    this.apiKey = opts.apiKey;
    this.userAgent = opts.userAgent;
    this.baseUrl = opts.baseUrl ?? 'https://api.acoustid.org/v2';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Recordings (with their releases) that match one file's fingerprint, best score first. */
  async lookup(fingerprint: string, durationS: number): Promise<AcoustIdRecording[]> {
    const body = new URLSearchParams({
      client: this.apiKey,
      format: 'json',
      duration: String(Math.round(durationS)),
      fingerprint,
      meta: 'recordings releases releasegroups',
    });
    const res = await this.fetchImpl(`${this.baseUrl}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.userAgent, Accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      // AcoustID explains 4xx in the body ({"status":"error","error":{"code":4,"message":"invalid API key"}});
      // keep that message, it is the only way to tell a bad key from a bad fingerprint
      let detail = '';
      let code: number | undefined;
      try {
        const err = (await res.json()) as { error?: { code?: number; message?: string } };
        detail = err?.error?.message ?? '';
        code = err?.error?.code;
      } catch { /* non-JSON body: status line is all we have */ }
      throw new AcoustIdError(`AcoustID ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`, res.status, code);
    }
    const parsed = acoustIdResponseSchema.parse(await res.json());
    if (parsed.status !== 'ok') {
      throw new AcoustIdError(parsed.error?.message ?? `AcoustID status ${parsed.status}`, 200, parsed.error?.code);
    }
    return flattenResults(parsed);
  }
}

/** Pure: result × recording → one row per recording with its releases, best score first. */
export function flattenResults(parsed: z.infer<typeof acoustIdResponseSchema>): AcoustIdRecording[] {
  const out: AcoustIdRecording[] = [];
  for (const result of parsed.results ?? []) {
    for (const rec of result.recordings ?? []) {
      out.push({
        score: result.score,
        recordingMbid: rec.id,
        ...(rec.title !== undefined ? { title: rec.title } : {}),
        ...(rec.duration !== undefined ? { durationS: rec.duration } : {}),
        releases: (rec.releases ?? []).map((r) => ({
          mbid: r.id,
          ...(r.releasegroup?.id !== undefined ? { releaseGroupMbid: r.releasegroup.id } : {}),
          ...(r.title !== undefined ? { title: r.title } : {}),
          ...(r.country !== undefined ? { country: r.country } : {}),
          ...(r.track_count !== undefined ? { trackCount: r.track_count } : {}),
          ...(r.medium_count !== undefined ? { mediumCount: r.medium_count } : {}),
        })),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Pure: rank the releases an album's tracks point at. Each track contributes
 * its best-scoring recording's releases; a release's score is the sum of those
 * scores, so a release that explains many tracks outranks one that explains
 * few. `coverage` = tracks that pointed at the release / tracks with a lookup.
 */
export function rankReleases(perTrack: AcoustIdRecording[][]): Array<AcoustIdRelease & { score: number; tracksMatched: number; coverage: number }> {
  const acc = new Map<string, AcoustIdRelease & { score: number; tracksMatched: number }>();
  const tracksWithLookup = perTrack.filter((recs) => recs.length > 0).length;
  for (const recs of perTrack) {
    const best = recs[0];
    if (!best) continue;
    const seen = new Set<string>();
    for (const rel of best.releases) {
      if (seen.has(rel.mbid)) continue;
      seen.add(rel.mbid);
      const cur = acc.get(rel.mbid) ?? { ...rel, score: 0, tracksMatched: 0 };
      cur.score += best.score;
      cur.tracksMatched += 1;
      acc.set(rel.mbid, cur);
    }
  }
  return [...acc.values()]
    .map((r) => ({ ...r, coverage: tracksWithLookup ? r.tracksMatched / tracksWithLookup : 0 }))
    .sort((a, b) => b.score - a.score || b.tracksMatched - a.tracksMatched);
}

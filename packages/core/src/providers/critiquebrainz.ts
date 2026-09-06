/**
 * CritiqueBrainz reviews by release-group MBID (spec REV-1, Appendix C).
 * Anonymous reads; MetaBrainz etiquette (1 req/s, identifying User-Agent) is
 * enforced by the caller's pacer. Every review carries its own licence
 * (CC BY-SA 3.0 or CC BY-NC-SA 3.0), which is stored and displayed.
 */
import { z } from 'zod';
import type { CallContext, ExternalReview } from './types.js';

const CB_BASE_URL = 'https://critiquebrainz.org/ws/1';
const EXCERPT_CHARS = 280;

const ReviewSchema = z.object({
  id: z.string(),
  entity_id: z.string().nullish(),
  text: z.string().nullish(),
  rating: z.number().nullish(),
  license_id: z.string().nullish(),
  full_name: z.string().nullish(),
  info_url: z.string().nullish(),
  language: z.string().nullish(),
  is_draft: z.boolean().nullish(),
  is_hidden: z.boolean().nullish(),
  published_on: z.string().nullish(),
  last_updated: z.string().nullish(),
  source: z.string().nullish(),
  source_url: z.string().nullish(),
  user: z.object({ display_name: z.string().nullish() }).nullish(),
});

const ReviewListSchema = z.object({
  count: z.number().nullish(),
  reviews: z.array(z.unknown()).nullish(),
});

/** 'CC BY-NC-SA-3.0' / 'cc-by-sa-3.0' / 'CC BY-SA 3.0' → the canonical short name. */
export function critiqueBrainzLicense(licenseId: string | null | undefined, fullName: string | null | undefined): string {
  const key = (licenseId ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (key === 'CCBYSA3.0') return 'CC BY-SA 3.0';
  if (key === 'CCBYNCSA3.0') return 'CC BY-NC-SA 3.0';
  if (fullName) return fullName;
  if (licenseId) return licenseId;
  return 'CritiqueBrainz review (licence unspecified)';
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** null for drafts, hidden reviews, unparsable payloads, or reviews with neither text nor rating. */
export function mapCritiqueBrainzReview(raw: unknown): ExternalReview | null {
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (r.is_draft || r.is_hidden) return null;
  const text = r.text?.trim() || undefined;
  const rating = typeof r.rating === 'number' ? r.rating : undefined;
  if (!text && rating === undefined) return null;
  const published = r.published_on ? new Date(r.published_on) : undefined;
  return {
    source: 'critiquebrainz',
    sourceId: r.id,
    url: `https://critiquebrainz.org/review/${r.id}`,
    ...(r.user?.display_name ? { author: r.user.display_name } : {}),
    ...(r.source ? { title: r.source } : {}),
    ...(text ? { bodyText: text, excerpt: excerptOf(text) } : {}),
    ...(rating !== undefined ? { ratingRaw: rating } : {}),
    ratingScale: 5,
    license: critiqueBrainzLicense(r.license_id, r.full_name),
    ...(r.language ? { language: r.language } : {}),
    ...(published && !Number.isNaN(published.getTime()) ? { publishedAt: published } : {}),
  };
}

export class CritiqueBrainzClient {
  id = 'critiquebrainz';
  private userAgent: string;
  private fetchImpl: typeof fetch;

  constructor(options: { userAgent: string; fetchImpl?: typeof fetch }) {
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getReviewsForReleaseGroup(rgMbid: string, _ctx: CallContext): Promise<ExternalReview[]> {
    const url = new URL(`${CB_BASE_URL}/review/`);
    url.searchParams.set('entity_id', rgMbid);
    url.searchParams.set('entity_type', 'release_group');
    url.searchParams.set('limit', '50');
    url.searchParams.set('sort', 'popularity');

    const response = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
    });
    if (response.status === 404) return [];
    if (response.status === 429 || response.status === 503) {
      const retryAfter = response.headers.get('Retry-After');
      const err = new Error(`CritiqueBrainz rate limited (${response.status})`);
      if (retryAfter) (err as { retryAfterMs?: number }).retryAfterMs = parseInt(retryAfter, 10) * 1000;
      throw err;
    }
    if (!response.ok) throw new Error(`CritiqueBrainz request failed: ${response.status} ${response.statusText}`);

    const data = ReviewListSchema.parse(await response.json());
    return (data.reviews ?? []).map(mapCritiqueBrainzReview).filter((r): r is ExternalReview => r !== null);
  }
}

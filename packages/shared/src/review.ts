import { z } from 'zod';

/**
 * Reviews and listening (spec §9.8 REV-1..3, §13 Reviews endpoints).
 * Ratings, reviews, clippings and listens are per release group; the
 * edition listened to is captured on the listen entry.
 */

export const listenFormatSchema = z.enum(['vinyl', 'cd', 'cassette', 'digital', 'stream', 'other'])
  .describe('How the owner listened (REV-3)');

export type ListenFormat = z.infer<typeof listenFormatSchema>;

/** 0.5–5.0 in half-star steps (REV-3). */
export const ownRatingSchema = z.number().min(0.5).max(5)
  .refine((v) => Number.isInteger(v * 2), 'rating must be in half-star steps');

export const putOwnReviewSchema = z.object({
  rating: ownRatingSchema.nullable().optional().describe('null clears the rating'),
  bodyMd: z.string().max(100_000).nullable().optional().describe('Markdown review body'),
  favoriteTrackIds: z.array(z.string().uuid()).max(100).optional(),
  tags: z.array(z.string().min(1).max(40)).max(30).optional().describe('Owner tags / moods'),
}).strict();

export type PutOwnReview = z.infer<typeof putOwnReviewSchema>;

export const ownReviewSchema = z.object({
  id: z.string().uuid(),
  releaseGroupId: z.string().uuid(),
  rating: z.number().nullable(),
  bodyMd: z.string().nullable(),
  favoriteTrackIds: z.array(z.string().uuid()),
  tags: z.array(z.string()),
  currentRevision: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type OwnReview = z.infer<typeof ownReviewSchema>;

export const reviewRevisionSchema = z.object({
  revision: z.number().int(),
  rating: z.number().nullable(),
  bodyMd: z.string().nullable(),
  editedAt: z.string().datetime(),
}).strict();

export type ReviewRevision = z.infer<typeof reviewRevisionSchema>;

export const createListenSchema = z.object({
  listenedAt: z.string().datetime().optional().describe('Defaults to now'),
  format: listenFormatSchema.optional(),
  releaseId: z.string().uuid().nullable().optional().describe('Edition listened to'),
  note: z.string().max(500).nullable().optional(),
}).strict();

export type CreateListen = z.infer<typeof createListenSchema>;

export const listenSchema = z.object({
  id: z.string().uuid(),
  releaseGroupId: z.string().uuid(),
  releaseId: z.string().uuid().nullable(),
  releaseTitle: z.string().nullable(),
  listenedAt: z.string().datetime(),
  format: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type Listen = z.infer<typeof listenSchema>;

export const createClippingSchema = z.object({
  url: z.string().url().max(2048).nullable().optional(),
  sourceLabel: z.string().max(255).nullable().optional(),
  scoreRaw: z.number().min(0).max(100).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
}).strict().refine((c) => !!(c.url || c.note), 'url or note required');

export type CreateClipping = z.infer<typeof createClippingSchema>;

export const clippingSchema = z.object({
  id: z.string().uuid(),
  releaseGroupId: z.string().uuid(),
  url: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  scoreRaw: z.number().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type Clipping = z.infer<typeof clippingSchema>;

export const externalReviewSourceSchema = z.enum(['critiquebrainz', 'wikipedia', 'musicbrainz', 'discogs']);

export type ExternalReviewSource = z.infer<typeof externalReviewSourceSchema>;

export const externalReviewSchema = z.object({
  id: z.string().uuid(),
  source: externalReviewSourceSchema,
  sourceId: z.string().nullable(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  title: z.string().nullable(),
  bodyText: z.string().nullable(),
  excerpt: z.string().nullable(),
  ratingRaw: z.number().nullable(),
  ratingScale: z.number().nullable(),
  ratingNormalized: z.number().nullable().describe('0–100'),
  license: z.string().describe('Displayed with the review (spec §10.2.6)'),
  language: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  fetchedAt: z.string().datetime().nullable(),
  stale: z.boolean().describe('Older than the source freshness rule (Discogs 6 h); a revalidation is queued'),
}).strict();

export type ExternalReview = z.infer<typeof externalReviewSchema>;

/** Display labels for link-out sources (REV-2); unknown sources fall back to the slug. */
export const REVIEW_LINK_SOURCES: Record<string, string> = {
  metacritic: 'Metacritic',
  allmusic: 'AllMusic',
  rateyourmusic: 'Rate Your Music',
  wikipedia: 'Wikipedia',
  pitchfork: 'Pitchfork',
  albumoftheyear: 'Album of the Year',
  sputnikmusic: 'Sputnikmusic',
  residentadvisor: 'Resident Advisor',
  thequietus: 'The Quietus',
  rollingstone: 'Rolling Stone',
  bandcamp: 'Bandcamp',
  bbc: 'BBC',
  guardian: 'The Guardian',
  nme: 'NME',
  popmatters: 'PopMatters',
  consequence: 'Consequence',
  stereogum: 'Stereogum',
  discogs: 'Discogs',
  musicbrainz: 'MusicBrainz',
};

export function reviewLinkLabel(source: string): string {
  return REVIEW_LINK_SOURCES[source] ?? source.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const reviewLinkSchema = z.object({
  source: z.string(),
  label: z.string(),
  url: z.string(),
  discoveredVia: z.enum(['wikidata', 'mb_relationship', 'template']),
}).strict();

export type ReviewLink = z.infer<typeof reviewLinkSchema>;

/**
 * One source of critic scores for an album (the album.critic-scores@1
 * facet): CritiqueBrainz from the reviews module, or a linked app such as
 * review-gatherer (Music Connections). Scores are 0–10; no review text.
 */
export const criticScoreSchema = z.object({
  source: z.object({ module: z.string(), ref: z.string().nullable(), label: z.string() }),
  aggregate: z.object({ score: z.number().nullable(), tier: z.string().nullable(), reviewCount: z.number() }).nullable(),
  reviews: z.array(z.object({
    /** "Pitchfork (via review-gatherer)"; kept for older clients, show `outlet` and `via` */
    label: z.string(),
    /** the publication: "Pitchfork", "CritiqueBrainz" */
    outlet: z.string(),
    /** the app that relayed it ("review-gatherer"); null for a source tagave reads itself */
    via: z.string().nullable(),
    score: z.number().nullable(),
    scoreRaw: z.string().nullable(),
    url: z.string().nullable(),
    publishedAt: z.string().nullable(),
  })),
  criticRatings: z.array(z.object({ label: z.string(), outlet: z.string(), via: z.string().nullable(), score: z.number().nullable(), scoreRaw: z.string() })),
  updatedAt: z.string().nullable(),
}).strict();

export type CriticScore = z.infer<typeof criticScoreSchema>;

export const reviewsBundleSchema = z.object({
  releaseGroupId: z.string().uuid(),
  fetchedAt: z.string().datetime().nullable().describe('Last external fetch; null while gathering'),
  gathering: z.boolean().describe('First external fetch in flight — client polls'),
  external: z.array(externalReviewSchema),
  links: z.array(reviewLinkSchema),
  clippings: z.array(clippingSchema),
  own: ownReviewSchema.nullable(),
  listens: z.array(listenSchema),
  /** The critic-scores facet: every source, labelled; unavailable when no provider is on. */
  criticScores: z.object({ available: z.boolean(), values: z.array(criticScoreSchema) }).optional(),
}).strict();

export type ReviewsBundle = z.infer<typeof reviewsBundleSchema>;

/**
 * Only http(s) URLs reach a page as a link: anything else (javascript:,
 * data:, a relative path) is null, so it renders as text or not at all.
 */
export function httpOnly(u: string | null | undefined): string | null {
  // no URL global here (shared builds without DOM or Node types): the scheme, then a host, no whitespace
  return u && /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(u) ? u : null;
}

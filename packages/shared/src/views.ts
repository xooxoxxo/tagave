import { z } from 'zod';

/**
 * A filter that takes one value or several. The wire form is a repeated query
 * parameter (`?genre=Rock&genre=Jazz`); a single string still parses, so saved
 * views written before multi-select keep working.
 */
function multi<T extends z.ZodTypeAny>(inner: T, max = 20) {
  return z
    .preprocess(
      (v) => (v === undefined || v === null || v === '' ? undefined : Array.isArray(v) ? v : [v]),
      z.array(inner).min(1).max(max),
    )
    .optional();
}

export const albumStateFilterSchema = z.enum(['matched', 'needs_review', 'unidentified', 'pending', 'as_is', 'ignored']);
export const albumGapFilterSchema = z.enum(['incomplete_album', 'duplicate', 'quality', 'none']);

/**
 * Album grid query (spec BRW-1): every filter and sort is URL-encoded so a
 * view is bookmarkable, and a saved view stores exactly this object.
 */
export const albumsQuerySchema = z.object({
  q: z.string().max(200).optional().describe('Title/artist substring'),
  artist: z.string().max(255).optional(),
  sort: z.enum(['artist', 'title', 'year', 'added_date', 'rating', 'listened']).optional(),
  state: multi(albumStateFilterSchema, 6),
  decided: z.enum(['auto_strong', 'chip_rule', 'first_candidate', 'by_me', 'manual_mbid']).optional(),
  review: z.enum(['reviewed', 'unreviewed', 'rated', 'listened']).optional(),
  genre: multi(z.string().max(100), 30).describe('Discogs genre/style or MB genre tag'),
  decade: multi(z.coerce.number().int().min(1900).max(2100), 15).describe('First year of each decade, e.g. 1990'),
  format: multi(z.string().max(20), 12).describe("'lossless' | 'lossy' | 'mixed' | containers such as 'flac'"),
  label: multi(z.string().max(255), 20),
  owned: z.enum(['both', 'digital']).optional().describe("'both' = also in the physical collection"),
  gap: multi(albumGapFilterSchema, 4),
  view: z.enum(['grid', 'list']).optional(),
}).strict();

export type AlbumsQuery = z.infer<typeof albumsQuerySchema>;

/** Filters that accept several values at once (the rail renders them as checkboxes). */
export const MULTI_FILTER_KEYS = ['state', 'genre', 'decade', 'format', 'label', 'gap'] as const;
export type MultiFilterKey = typeof MULTI_FILTER_KEYS[number];

export const facetCountSchema = z.object({ value: z.string(), label: z.string().optional(), count: z.number().int() }).strict();

export const albumFacetsSchema = z.object({
  total: z.number().int(),
  states: z.array(facetCountSchema),
  formats: z.array(facetCountSchema).describe('lossless / lossy / mixed'),
  containers: z.array(facetCountSchema),
  decades: z.array(facetCountSchema),
  genres: z.array(facetCountSchema),
  labels: z.array(facetCountSchema),
  review: z.array(facetCountSchema),
  gaps: z.array(facetCountSchema),
  owned: z.array(facetCountSchema),
  decided: z.array(facetCountSchema),
}).strict();

export type AlbumFacets = z.infer<typeof albumFacetsSchema>;

export const savedViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  query: albumsQuerySchema,
  createdAt: z.string().datetime(),
}).strict();

export type SavedView = z.infer<typeof savedViewSchema>;

export const createSavedViewSchema = z.object({
  name: z.string().min(1).max(80),
  query: albumsQuerySchema,
}).strict();

export type CreateSavedView = z.infer<typeof createSavedViewSchema>;

/**
 * Bulk actions on a grid selection (spec §14.2 "multi-select … for bulk
 * actions"). Either an explicit id list or "everything matching the current
 * filters"; jobs are capped so one click cannot flood the provider budget.
 */
export const bulkAlbumActionSchema = z.enum(['ignore', 'unignore', 'as_is', 'identify', 'fetch_art', 'prefer']);
export type BulkAlbumAction = z.infer<typeof bulkAlbumActionSchema>;

export const BULK_JOB_CAP = 2000;
export const BULK_UPDATE_CAP = 20000;

export const bulkAlbumsRequestSchema = z.object({
  action: bulkAlbumActionSchema,
  albumIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  allMatching: z.boolean().optional().describe('Apply to every album matching `query` instead of `albumIds`'),
  query: albumsQuerySchema.optional(),
}).strict().refine((d) => !!d.albumIds?.length || d.allMatching === true, {
  message: 'albumIds or allMatching required',
});

export type BulkAlbumsRequest = z.infer<typeof bulkAlbumsRequestSchema>;

export const bulkAlbumsResultSchema = z.object({
  action: bulkAlbumActionSchema,
  matched: z.number().int().describe('Albums the selection resolved to'),
  updated: z.number().int(),
  queued: z.number().int(),
  capped: z.boolean().describe('The selection was larger than the cap for this action'),
}).strict();

export type BulkAlbumsResult = z.infer<typeof bulkAlbumsResultSchema>;

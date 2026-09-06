import { z } from 'zod';

/**
 * Album grid query (spec BRW-1): every filter and sort is URL-encoded so a
 * view is bookmarkable, and a saved view stores exactly this object.
 */
export const albumsQuerySchema = z.object({
  q: z.string().max(200).optional().describe('Title/artist substring'),
  artist: z.string().max(255).optional(),
  sort: z.enum(['artist', 'title', 'year', 'added_date', 'rating', 'listened']).optional(),
  state: z.enum(['matched', 'needs_review', 'unidentified', 'pending', 'as_is', 'ignored']).optional(),
  decided: z.enum(['auto_strong', 'chip_rule', 'first_candidate', 'by_me', 'manual_mbid']).optional(),
  review: z.enum(['reviewed', 'unreviewed', 'rated', 'listened']).optional(),
  genre: z.string().max(100).optional().describe('Discogs genre/style or MB genre tag'),
  decade: z.number().int().min(1900).max(2100).optional().describe('First year of the decade, e.g. 1990'),
  format: z.string().max(20).optional().describe("'lossless' | 'lossy' | 'mixed' | a container such as 'flac'"),
  label: z.string().max(255).optional(),
  owned: z.enum(['both', 'digital']).optional().describe("'both' = also in the physical collection"),
  gap: z.enum(['incomplete_album', 'duplicate', 'quality', 'none']).optional(),
  view: z.enum(['grid', 'list']).optional(),
}).strict();

export type AlbumsQuery = z.infer<typeof albumsQuerySchema>;

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

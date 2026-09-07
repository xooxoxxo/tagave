/**
 * @liner/shared - Shared Zod schemas and TypeScript types
 *
 * Exports organized by domain:
 * - Schemas with .Schema suffix for validation
 * - Types inferred from schemas
 * - Utility functions and enums
 *
 * Usage:
 *   import { sessionUserSchema, type SessionUser } from '@liner/shared';
 *   const validated = sessionUserSchema.parse(data);
 */

// Auth domain
export {
  userRoleSchema,
  type UserRole,
  setupRequestSchema,
  type SetupRequest,
  loginRequestSchema,
  type LoginRequest,
  sessionUserSchema,
  type SessionUser,
} from './auth.js';

// Library and scanning
export {
  scanRootSchema,
  type ScanRoot,
  createScanRootSchema,
  type CreateScanRootRequest,
  patchScanRootSchema,
  type PatchScanRootRequest,
  librarySchema,
  type Library,
  scanStatsSchema,
  type ScanStats,
  genreMapSchema,
  type GenreMap,
  librarySettingsViewSchema,
  type LibrarySettingsView,
  patchLibrarySettingsSchema,
  type PatchLibrarySettings,
} from './library.js';

// Album data
export {
  albumStateSchema,
  type AlbumState,
  formatBreakdownSchema,
  type FormatBreakdown,
  qualityFlagSchema,
  type QualityFlag,
  albumSummarySchema,
  type AlbumSummary,
  matchInfoSchema,
  type MatchInfo,
  localTrackSchema,
  type LocalTrack,
  localFileSchema,
  type LocalFile,
  canonicalTrackSchema,
  type CanonicalTrack,
  externalLinkSchema,
  type ExternalLink,
  albumDetailSchema,
  type AlbumDetail,
  metadataDiffSchema,
  type MetadataDiff,
} from './album.js';

// Album grid query, facets, saved views (BRW-1)
export {
  albumsQuerySchema,
  type AlbumsQuery,
  albumStateFilterSchema,
  albumGapFilterSchema,
  MULTI_FILTER_KEYS,
  type MultiFilterKey,
  bulkAlbumActionSchema,
  type BulkAlbumAction,
  bulkAlbumsRequestSchema,
  type BulkAlbumsRequest,
  bulkAlbumsResultSchema,
  type BulkAlbumsResult,
  BULK_JOB_CAP,
  BULK_UPDATE_CAP,
  facetCountSchema,
  albumFacetsSchema,
  type AlbumFacets,
  savedViewSchema,
  type SavedView,
  createSavedViewSchema,
  type CreateSavedView,
} from './views.js';

// Reviews and listens (REV-1..3)
export {
  listenFormatSchema,
  type ListenFormat,
  ownRatingSchema,
  putOwnReviewSchema,
  type PutOwnReview,
  ownReviewSchema,
  type OwnReview,
  reviewRevisionSchema,
  type ReviewRevision,
  createListenSchema,
  type CreateListen,
  listenSchema,
  type Listen,
  createClippingSchema,
  type CreateClipping,
  clippingSchema,
  type Clipping,
  externalReviewSourceSchema,
  type ExternalReviewSource,
  externalReviewSchema,
  type ExternalReview,
  REVIEW_LINK_SOURCES,
  reviewLinkLabel,
  reviewLinkSchema,
  type ReviewLink,
  reviewsBundleSchema,
  type ReviewsBundle,
} from './review.js';

// Jobs and SSE events
export {
  jobTypeSchema,
  type JobType,
  jobStateSchema,
  type JobState,
  jobSubjectTypeSchema,
  type JobSubjectType,
  jobProgressSchema,
  type JobProgress,
  jobRunSchema,
  type JobRun,
  providerStateSchema,
  type ProviderState,
  jobProgressEventSchema,
  type JobProgressEvent,
  jobCompletedEventSchema,
  type JobCompletedEvent,
  jobFailedEventSchema,
  type JobFailedEvent,
  scanStatsEventSchema,
  type ScanStatsEvent,
  queueChangedEventSchema,
  type QueueChangedEvent,
  providerStateEventSchema,
  type ProviderStateEvent,
  sseEventSchema,
  type SseEvent,
} from './job.js';

// Pagination
export {
  paginationEnvelopeSchema,
  paginationParamsSchema,
  type PaginationParams,
  type PaginationEnvelope,
} from './pagination.js';

// Problem details and errors
export {
  problemDetailsSchema,
  type ProblemDetails,
  HttpStatusCode,
  createProblemDetails,
} from './problem.js';

// Canonical fields and tag mapping
export {
  CanonicalField,
  type CanonicalField as CanonicalFieldType,
  canonicalFieldSchema,
  type TagSet,
  tagSetSchema,
} from './tags.js';

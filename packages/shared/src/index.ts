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

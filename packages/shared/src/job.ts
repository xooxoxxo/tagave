import { z } from 'zod';
import { scanStatsSchema } from './library.js';

/**
 * Job types per spec Section 12.3 and 11.4
 */
export const jobTypeSchema = z.enum([
  'scan_root',
  'scan_parse',
  'cluster_dir',
  'identify_album',
  'enrich_release',
  'enrich_artist',
  'fetch_art',
  'gap_recompute',
  'artist_refresh',
  'reviews_fetch',
  'tags_preview',
  'tags_apply',
  'tags_revert',
  'collection_sync',
  'fingerprint',
  'lint_album',
]).describe('Job type identifier');

export type JobType = z.infer<typeof jobTypeSchema>;

/**
 * Job state per spec Section 11.4
 */
export const jobStateSchema = z.enum([
  'created',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]).describe('Current job state');

export type JobState = z.infer<typeof jobStateSchema>;

/**
 * Subject type for job scoping
 */
export const jobSubjectTypeSchema = z.enum([
  'library',
  'scan_root',
  'local_album',
  'release',
  'tag_plan',
  'artist',
]).describe('What entity the job operates on');

export type JobSubjectType = z.infer<typeof jobSubjectTypeSchema>;

/**
 * Job progress info per spec Section 11.4
 */
export const jobProgressSchema = z.object({
  done: z.number().int().nonnegative().describe('Items completed'),
  total: z.number().int().positive().describe('Total items'),
  etaS: z.number().int().nonnegative().optional().describe('Estimated seconds remaining'),
  message: z.string().optional().describe('Current operation message'),
}).strict();

export type JobProgress = z.infer<typeof jobProgressSchema>;

/**
 * JobRun — a single job execution
 * Maps to `job_runs` table in spec Section 11.4
 */
export const jobRunSchema = z.object({
  id: z.string().uuid().describe('Job ID (UUIDv7)'),
  libraryId: z.string().uuid(),
  pgbossId: z.string().optional().describe('pg-boss internal job ID'),
  type: jobTypeSchema,
  subjectType: jobSubjectTypeSchema.optional(),
  subjectId: z.string().uuid().optional().describe('What entity this job operates on'),
  state: jobStateSchema,
  progress: jobProgressSchema.optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional().describe('Error message if state = failed'),
  createdAt: z.string().datetime(),
}).strict();

export type JobRun = z.infer<typeof jobRunSchema>;

/**
 * Provider state info for rate limiting and circuit breaker
 * Maps to `provider_state` table in spec Section 11.4
 */
export const providerStateSchema = z.object({
  provider: z.string().describe('Provider name (musicbrainz, discogs, etc.)'),
  windowStartedAt: z.string().datetime().optional().describe('Rate limit window start'),
  requestsUsed: z.number().int().nonnegative().optional().describe('Requests used in current window'),
  circuitOpenUntil: z.string().datetime().optional().describe('Circuit breaker expiration'),
  last429At: z.string().datetime().optional().describe('Last 429 Too Many Requests'),
  lastError: z.string().optional().describe('Last error message'),
}).strict();

export type ProviderState = z.infer<typeof providerStateSchema>;

/**
 * SSE event: job progress update
 * Per spec Section 13: `job.progress`
 */
export const jobProgressEventSchema = z.object({
  type: z.literal('job.progress'),
  jobId: z.string().uuid(),
  progress: jobProgressSchema,
  timestamp: z.string().datetime(),
}).strict();

export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;

/**
 * SSE event: job completed
 * Per spec Section 13: `job.completed`
 */
export const jobCompletedEventSchema = z.object({
  type: z.literal('job.completed'),
  jobId: z.string().uuid(),
  jobType: jobTypeSchema,
  result: z.record(z.any()).optional().describe('Job result payload'),
  timestamp: z.string().datetime(),
}).strict();

export type JobCompletedEvent = z.infer<typeof jobCompletedEventSchema>;

/**
 * SSE event: job failed
 * Per spec Section 13: `job.failed`
 */
export const jobFailedEventSchema = z.object({
  type: z.literal('job.failed'),
  jobId: z.string().uuid(),
  jobType: jobTypeSchema,
  error: z.string(),
  timestamp: z.string().datetime(),
}).strict();

export type JobFailedEvent = z.infer<typeof jobFailedEventSchema>;

/**
 * SSE event: scan stats
 * Per spec Section 13: `scan.stats`
 */
export const scanStatsEventSchema = z.object({
  type: z.literal('scan.stats'),
  scanRootId: z.string().uuid(),
  stats: scanStatsSchema,
  timestamp: z.string().datetime(),
}).strict();

export type ScanStatsEvent = z.infer<typeof scanStatsEventSchema>;

/**
 * SSE event: queue changed (new items, decisions made)
 * Per spec Section 13: `queue.changed`
 */
export const queueChangedEventSchema = z.object({
  type: z.literal('queue.changed'),
  libraryId: z.string().uuid(),
  queueCount: z.number().int().nonnegative().describe('Number of albums needing review'),
  change: z.enum(['item_added', 'item_removed', 'item_updated']),
  affectedAlbumId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
}).strict();

export type QueueChangedEvent = z.infer<typeof queueChangedEventSchema>;

/**
 * SSE event: provider state changed
 * Per spec Section 13: `provider.state`
 */
export const providerStateEventSchema = z.object({
  type: z.literal('provider.state'),
  provider: z.string(),
  state: providerStateSchema,
  timestamp: z.string().datetime(),
}).strict();

export type ProviderStateEvent = z.infer<typeof providerStateEventSchema>;

/**
 * Union of all SSE event types
 */
export const sseEventSchema = z.union([
  jobProgressEventSchema,
  jobCompletedEventSchema,
  jobFailedEventSchema,
  scanStatsEventSchema,
  queueChangedEventSchema,
  providerStateEventSchema,
]).describe('Server-sent event from /libraries/{lib}/jobs/stream');

export type SseEvent =
  | JobProgressEvent
  | JobCompletedEvent
  | JobFailedEvent
  | ScanStatsEvent
  | QueueChangedEvent
  | ProviderStateEvent;

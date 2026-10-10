import { z } from 'zod';

/**
 * Settings › Storage: what tagave keeps on disk. The database is broken down
 * into groups of tables (pg_total_relation_size, so indexes and TOAST count),
 * and the folders the app owns are walked for their file sizes.
 */
export const STORAGE_CATEGORIES = [
  { key: 'library', label: 'Music file index', description: 'Every scanned file, track, album folder and sidecar, plus the search index built from them.' },
  { key: 'catalogue', label: 'Catalogue', description: 'Matched releases, artists, labels, credits and provider IDs.' },
  { key: 'artwork', label: 'Album art', description: 'Cover thumbnails stored in the database and where each cover came from.' },
  { key: 'providerCache', label: 'Provider cache', description: 'Answers from MusicBrainz, Discogs and other providers, kept so they are not asked twice.' },
  { key: 'tagChanges', label: 'Tag changes', description: 'Plans with their previews and the old tags Revert puts back.' },
  { key: 'care', label: 'Library care and collection', description: 'Gaps, identification runs, reviews, listens and your physical collection.' },
  { key: 'jobs', label: 'Job queue', description: 'Background jobs, their history and worker heartbeats.' },
  { key: 'other', label: 'Everything else', description: 'Accounts, settings, migrations and Postgres housekeeping.' },
] as const;
export type StorageCategoryKey = typeof STORAGE_CATEGORIES[number]['key'];

const TABLE_CATEGORY: Record<string, StorageCategoryKey> = {
  audio_files: 'library', local_tracks: 'library', local_albums: 'library', sidecar_files: 'library',
  scan_roots: 'library', scan_dirs: 'library', scans: 'library', album_facets: 'library',
  facet_state: 'library', search_documents: 'library', cluster_overrides: 'library', artist_list: 'library',
  release_groups: 'catalogue', releases: 'catalogue', recordings: 'catalogue', canonical_tracks: 'catalogue',
  artists: 'catalogue', labels: 'catalogue', credits: 'catalogue', external_ids: 'catalogue',
  album_matches: 'catalogue', match_candidates: 'catalogue', release_group_artists: 'catalogue',
  entity_tags: 'catalogue', external_reviews: 'catalogue', review_links: 'catalogue',
  images: 'artwork', image_sources: 'artwork',
  provider_cache: 'providerCache', provider_state: 'providerCache',
  tag_plans: 'tagChanges', tag_plan_items: 'tagChanges',
  gaps: 'care', identify_runs: 'care', field_locks: 'care', followed_artists: 'care',
  user_reviews: 'care', user_review_revisions: 'care', listens: 'care', clippings: 'care',
  collection_items: 'care', collection_sources: 'care', wantlist_items: 'care', player_links: 'care',
  job_runs: 'jobs', worker_heartbeats: 'jobs',
};

/** The group a table belongs to; pg-boss's own schema is the job queue. */
export function storageCategoryOf(schema: string, table: string): StorageCategoryKey {
  if (schema === 'pgboss') return 'jobs';
  if (schema !== 'public') return 'other';
  return TABLE_CATEGORY[table] ?? 'other';
}

export interface StorageCategoryView {
  key: StorageCategoryKey;
  label: string;
  description: string;
  bytes: number;
  /** The largest tables in the group, biggest first. */
  tables: Array<{ name: string; bytes: number }>;
}

export interface StorageFolderView {
  key: 'cache' | 'backups';
  label: string;
  path: string;
  bytes: number;
  files: number;
  exists: boolean;
  /** The walk stopped early (very many files); the size is a lower bound. */
  truncated: boolean;
  error: string | null;
}

export interface StorageOverview {
  checkedAt: string;
  database: {
    /** pg_database_size: tables plus the system catalogs and free pages. */
    totalBytes: number;
    categories: StorageCategoryView[];
  };
  folders: StorageFolderView[];
}

/** archived: only archived plans; finished: every finished plan, archived or not. */
export const tagChangeCleanupScopeSchema = z.enum(['archived', 'finished']);
export type TagChangeCleanupScope = z.infer<typeof tagChangeCleanupScopeSchema>;

export const tagChangeCleanupRequestSchema = z.object({
  scope: tagChangeCleanupScopeSchema,
  /**
   * Also delete plans that can still be reverted (they wrote files and hold
   * the old tags). Off unless the owner picks it in the confirm.
   */
  includeRevertible: z.boolean().default(false),
}).strict();
export type TagChangeCleanupRequest = z.infer<typeof tagChangeCleanupRequestSchema>;

export interface TagChangeCleanupPreview {
  scope: TagChangeCleanupScope;
  /** Plans that can go without losing anything Revert needs. */
  plans: number;
  bytes: number;
  /** Plans that can still be reverted: deleted only when asked for. */
  revertible: { plans: number; bytes: number };
}

export interface TagChangeCleanupResult {
  deletedPlans: number;
  freedBytes: number;
}

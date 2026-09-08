import {
  bigint,
  customType,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Platform tables (not library-scoped)

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: varchar({ length: 255 }).notNull().unique(),
  displayName: varchar({ length: 255 }),
  passwordHash: varchar({ length: 255 }).notNull(),
  role: varchar({ length: 20 }).notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const libraries = pgTable('libraries', {
  id: uuid().primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar({ length: 255 }).notNull(),
  settings: jsonb().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerState = pgTable('provider_state', {
  provider: varchar({ length: 50 }).primaryKey(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
  requestsUsed: integer('requests_used').default(0),
  circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true }),
  last429At: timestamp('last_429_at', { withTimezone: true }),
  lastError: text('last_error'),
  nextSlotAt: timestamp('next_slot_at', { withTimezone: true }),
});

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    pgbossId: varchar('pgboss_id', { length: 255 }),
    type: varchar({ length: 50 }).notNull(),
    subjectType: varchar('subject_type', { length: 50 }),
    subjectId: uuid('subject_id'),
    state: varchar({ length: 20 }).notNull().default('created'),
    progress: jsonb().default('{"done": 0, "total": 0}'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_job_runs_library').on(table.libraryId),
  })
);

// Observed layer (per library)

export const scanRoots = pgTable(
  'scan_roots',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    path: varchar({ length: 2048 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    writable: boolean().notNull().default(true),
    enabled: boolean().notNull().default(true),
    pollIntervalS: integer('poll_interval_s').notNull().default(21600),
    lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
    lastStatus: varchar('last_status', { length: 50 }),
    validationStatus: varchar('validation_status', { length: 20 }).notNull().default('pending'),
    validationMessage: varchar('validation_message'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    probeWritable: boolean('probe_writable'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_scan_roots_library').on(table.libraryId),
    validationStatusCheck: check('validation_status_check', sql`validation_status in ('pending','ok','missing','not_directory','unreadable')`),
  })
);

export const scans = pgTable(
  'scans',
  {
    id: uuid().primaryKey().defaultRandom(),
    scanRootId: uuid('scan_root_id')
      .notNull()
      .references(() => scanRoots.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: varchar({ length: 20 }).notNull().default('running'),
    stats: jsonb().default('{}'),
    cursor: jsonb(),
  },
  (table) => ({
    scanRootIdx: index('idx_scans_scan_root').on(table.scanRootId),
  })
);

/** Directory mtimes per root for quick scans (0019). */
export const scanDirs = pgTable(
  'scan_dirs',
  {
    scanRootId: uuid('scan_root_id')
      .notNull()
      .references(() => scanRoots.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    mtime: bigint({ mode: 'number' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.scanRootId, table.relPath] }),
  })
);

export const audioFiles = pgTable(
  'audio_files',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    scanRootId: uuid('scan_root_id')
      .notNull()
      .references(() => scanRoots.id, { onDelete: 'cascade' }),
    relPath: varchar('rel_path', { length: 2048 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mtime: bigint({ mode: 'number' }),
    inode: varchar({ length: 100 }),
    container: varchar({ length: 20 }),
    codec: varchar({ length: 50 }),
    lossless: boolean(),
    durationMs: integer('duration_ms'),
    sampleRate: integer('sample_rate'),
    bitDepth: integer('bit_depth'),
    channels: integer(),
    bitrateKbps: integer('bitrate_kbps'),
    hasEmbeddedArt: boolean('has_embedded_art').default(false),
    tagsRaw: jsonb('tags_raw'),
    tagsDigest: varchar('tags_digest', { length: 64 }),
    tagsReadAt: timestamp('tags_read_at', { withTimezone: true }),
    audioHash: varchar('audio_hash', { length: 64 }),
    audioHashAt: timestamp('audio_hash_at', { withTimezone: true }),
    fingerprint: varchar({ length: 255 }),
    fingerprintDuration: integer('fingerprint_duration'),
    status: varchar({ length: 20 }).notNull().default('present'),
    parseError: text('parse_error'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scanRootPathKey: uniqueIndex('audio_files_scan_root_id_rel_path_key').on(
      table.scanRootId,
      table.relPath
    ),
    libraryIdx: index('idx_audio_files_library').on(table.libraryId),
    scanRootIdx: index('idx_audio_files_scan_root').on(table.scanRootId),
    statusIdx: index('idx_audio_files_status').on(table.status),
  })
);

export const sidecarFiles = pgTable(
  'sidecar_files',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    scanRootId: uuid('scan_root_id')
      .notNull()
      .references(() => scanRoots.id, { onDelete: 'cascade' }),
    relPath: varchar('rel_path', { length: 2048 }).notNull(),
    kind: varchar({ length: 20 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mtime: bigint({ mode: 'number' }),
    /** the last walk that saw the file; rows a completed walk did not see are removed (0021) */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_sidecar_files_library').on(table.libraryId),
    rootPathKey: uniqueIndex('sidecar_files_root_path_key').on(table.scanRootId, table.relPath),
  })
);

export const localAlbums = pgTable(
  'local_albums',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    clusterKey: varchar('cluster_key', { length: 512 }).notNull(),
    dirPaths: text('dir_paths').array().notNull().default(sql`'{}'`),
    titleGuess: varchar('title_guess', { length: 255 }),
    artistGuess: varchar('artist_guess', { length: 255 }),
    yearGuess: integer('year_guess'),
    discCount: integer('disc_count'),
    trackCount: integer('track_count'),
    totalDurationMs: integer('total_duration_ms'),
    formats: text().array().default(sql`'{}'`),
    state: varchar({ length: 20 }).notNull().default('pending'),
    releaseId: uuid('release_id'),
    releaseGroupId: uuid('release_group_id'),
    qualityFlags: jsonb('quality_flags').default('[]'),
    preferred: boolean().default(false),
    /** why unidentified / needs review: no_tags | no_candidates | weak_candidates | ambiguous | provider_errors */
    identifyReason: varchar('identify_reason', { length: 40 }),
    identifyAttempts: integer('identify_attempts').notNull().default(0),
    lastIdentifyAt: timestamp('last_identify_at', { withTimezone: true }),
    identifiedAt: timestamp('identified_at', { withTimezone: true }),
    /** first MusicBrainz release id found in the album's file tags (IDN-1a fast path); feeds the fast-path metrics */
    embeddedMbid: varchar('embedded_mbid', { length: 36 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_local_albums_library').on(table.libraryId),
    clusterKeyIdx: index('idx_local_albums_cluster_key').on(table.clusterKey),
    stateIdx: index('idx_local_albums_state').on(table.state),
    releaseGroupIdx: index('idx_local_albums_release_group_id').on(table.releaseGroupId),
  })
);

export const localTracks = pgTable(
  'local_tracks',
  {
    id: uuid().primaryKey().defaultRandom(),
    localAlbumId: uuid('local_album_id').references(() => localAlbums.id, { onDelete: 'cascade' }),
    audioFileId: uuid('audio_file_id')
      .notNull()
      .references(() => audioFiles.id, { onDelete: 'cascade' }),
    discNo: integer('disc_no'),
    trackNo: integer('track_no'),
    titleGuess: varchar('title_guess', { length: 255 }),
    artistGuess: varchar('artist_guess', { length: 255 }),
    durationMs: integer('duration_ms'),
    canonicalTrackId: uuid('canonical_track_id'),
    recordingId: uuid('recording_id'),
    matchDistance: numeric('match_distance', { precision: 5, scale: 4 }),
    state: varchar({ length: 20 }).default('unmatched'),
    origin: varchar({ length: 10 }).notNull().default('file'),
    cueStartMs: integer('cue_start_ms'),
    cueRelPath: varchar('cue_rel_path', { length: 2048 }),
  },
  (table) => ({
    albumIdx: index('idx_local_tracks_album').on(table.localAlbumId),
    audioFileIdx: index('idx_local_tracks_audio_file').on(table.audioFileId),
    originCheck: check('origin_check', sql`origin in ('file', 'cue')`),
  })
);

export const clusterOverrides = pgTable(
  'cluster_overrides',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    audioFileId: uuid('audio_file_id')
      .notNull()
      .references(() => audioFiles.id, { onDelete: 'cascade' }),
    localAlbumId: uuid('local_album_id').references(() => localAlbums.id, {
      onDelete: 'cascade',
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_cluster_overrides_library').on(table.libraryId),
  })
);

// Canonical layer (global cache)

export const artists = pgTable(
  'artists',
  {
    id: uuid().primaryKey().defaultRandom(),
    mbid: varchar({ length: 36 }).unique(),
    discogsId: integer('discogs_id').unique(),
    name: varchar({ length: 255 }).notNull(),
    sortName: varchar('sort_name', { length: 255 }),
    disambiguation: text(),
    type: varchar({ length: 50 }),
    country: varchar({ length: 2 }),
    beginDate: date('begin_date'),
    endDate: date('end_date'),
    bio: jsonb(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    aliases: text().array().notNull().default(sql`'{}'`),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    enrichError: text('enrich_error'),
  },
  (table) => ({
    mbidIdx: index('idx_artists_mbid').on(table.mbid),
  })
);

// Synthetic RG limitation (XO-302): if Discogs later assigns a master to a masterless release,
// the synthetic RG (identified by discogs_release_id) is not migrated automatically;
// on-demand refresh only.
export const releaseGroups = pgTable(
  'release_groups',
  {
    id: uuid().primaryKey().defaultRandom(),
    mbid: varchar({ length: 36 }).unique(),
    discogsmasterId: integer('discogs_master_id').unique(),
    // Synthetic RG for Discogs-only release (no master).
    discogsReleaseId: integer('discogs_release_id').unique(),
    title: varchar({ length: 255 }).notNull(),
    primaryType: varchar('primary_type', { length: 50 }),
    secondaryTypes: text('secondary_types').array().default(sql`'{}'`),
    firstReleaseDate: date('first_release_date'),
    artistCredit: jsonb('artist_credit'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    editionsFetchedAt: timestamp('editions_fetched_at', { withTimezone: true }),
    reviewsFetchedAt: timestamp('reviews_fetched_at', { withTimezone: true }),
    artistsResolvedAt: timestamp('artists_resolved_at', { withTimezone: true }),
  },
  (table) => ({
    mbidIdx: index('idx_release_groups_mbid').on(table.mbid),
    discogsIdx: index('idx_release_groups_discogs_master_id').on(table.discogsmasterId),
    identityCheck: check(
      'release_groups_identity',
      sql`mbid IS NOT NULL OR discogs_master_id IS NOT NULL OR discogs_release_id IS NOT NULL`
    ),
  })
);

export const releaseGroupArtists = pgTable(
  'release_group_artists',
  {
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    creditedName: varchar('credited_name', { length: 255 }),
    joinPhrase: varchar('join_phrase', { length: 50 }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.releaseGroupId, table.position] }),
    artistIdx: index('idx_rga_artist').on(table.artistId),
  })
);

export const releases = pgTable(
  'releases',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    mbid: varchar({ length: 36 }).unique(),
    discogsReleaseId: integer('discogs_release_id').unique(),
    title: varchar({ length: 255 }).notNull(),
    status: varchar({ length: 50 }),
    date: date(),
    country: varchar({ length: 2 }),
    barcode: varchar({ length: 50 }),
    labels: jsonb().default('[]'),
    media: jsonb().default('[]'),
    trackCount: integer('track_count'),
    packaging: varchar({ length: 50 }),
    sourceOfTruth: varchar('source_of_truth', { length: 20 }).default('musicbrainz'),
    bridgeAttemptedAt: timestamp('bridge_attempted_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  },
  (table) => ({
    releaseGroupIdx: index('idx_releases_release_group').on(table.releaseGroupId),
    mbidIdx: index('idx_releases_mbid').on(table.mbid),
    discogsReleaseIdx: index('idx_releases_discogs_release_id').on(table.discogsReleaseId),
  })
);

export const canonicalTracks = pgTable(
  'canonical_tracks',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    mediumNo: integer('medium_no'),
    position: integer(),
    number: varchar({ length: 20 }),
    title: varchar({ length: 255 }).notNull(),
    artistCredit: jsonb('artist_credit'),
    recordingId: uuid('recording_id'),
    lengthMs: integer('length_ms'),
    isDataTrack: boolean('is_data_track').default(false),
    isVideo: boolean('is_video').default(false),
  },
  (table) => ({
    releaseIdx: index('idx_canonical_tracks_release').on(table.releaseId),
  })
);

export const recordings = pgTable(
  'recordings',
  {
    id: uuid().primaryKey().defaultRandom(),
    mbid: varchar({ length: 36 }).unique(),
    title: varchar({ length: 255 }).notNull(),
    lengthMs: integer('length_ms'),
    isrcs: text().array().default(sql`'{}'`),
    acoustids: text().array().default(sql`'{}'`),
    workMbid: varchar('work_mbid', { length: 36 }),
  },
  (table) => ({
    mbidIdx: index('idx_recordings_mbid').on(table.mbid),
  })
);

export const labels = pgTable(
  'labels',
  {
    id: uuid().primaryKey().defaultRandom(),
    mbid: varchar({ length: 36 }).unique(),
    discogsId: integer('discogs_id').unique(),
    name: varchar({ length: 255 }).notNull(),
    country: varchar({ length: 2 }),
  },
  (table) => ({
    mbidIdx: index('idx_labels_mbid').on(table.mbid),
  })
);

export const entityTags = pgTable(
  'entity_tags',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    tag: varchar({ length: 100 }).notNull(),
    kind: varchar({ length: 20 }).notNull(),
    source: varchar({ length: 50 }).notNull(),
    weight: numeric({ precision: 10, scale: 4 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entityIdx: index('idx_entity_tags_entity').on(table.entityType, table.entityId),
    // facet joins probe by entity id alone (release group or release), 0017
    entityIdIdx: index('idx_entity_tags_entity_id').on(table.entityId, table.kind),
    // Note: actual UNIQUE constraint in SQL is (entity_type, entity_id, kind, source, lower(tag))
    // for case-insensitive uniqueness; drizzle schema defines plain columns only.
  })
);

export const credits = pgTable(
  'credits',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    role: varchar({ length: 100 }).notNull(),
    source: varchar({ length: 50 }).notNull(),
  },
  (table) => ({
    entityIdx: index('idx_credits_entity').on(table.entityType, table.entityId),
  })
);

export const imageSources = pgTable(
  'image_sources',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: varchar({ length: 50 }).notNull(),
    provider: varchar({ length: 50 }).notNull(),
    sourceUrl: varchar('source_url', { length: 2048 }),
    width: integer(),
    height: integer(),
    licenseNote: text('license_note').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  },
  (table) => ({
    entityIdx: index('idx_image_sources_entity').on(table.entityType, table.entityId),
    naturalIdx: uniqueIndex('uq_image_sources_natural').on(
      table.entityType,
      table.entityId,
      table.provider,
      table.kind
    ),
  })
);

export const externalIds = pgTable(
  'external_ids',
  {
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    provider: varchar({ length: 50 }).notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    url: varchar({ length: 2048 }),
    confidence: numeric({ precision: 5, scale: 4 }),
    source: varchar({ length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.externalId, table.entityType, table.entityId] }),
    entityIdx: index('idx_external_ids_entity').on(table.entityType, table.entityId),
    entityProviderIdx: index('idx_external_ids_entity_provider').on(table.entityType, table.entityId, table.provider),
  })
);

export const externalReviews = pgTable(
  'external_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    source: varchar({ length: 50 }).notNull(),
    sourceId: varchar('source_id', { length: 255 }),
    url: varchar({ length: 2048 }),
    author: varchar({ length: 255 }),
    title: varchar({ length: 255 }),
    bodyText: text('body_text'),
    excerpt: text(),
    ratingRaw: numeric('rating_raw', { precision: 5, scale: 2 }),
    ratingScale: integer('rating_scale'),
    ratingNormalized: integer('rating_normalized'),
    license: text().notNull(),
    language: varchar({ length: 10 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  },
  (table) => ({
    releaseGroupIdx: index('idx_external_reviews_release_group').on(table.releaseGroupId),
  })
);

export const reviewLinks = pgTable(
  'review_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    source: varchar({ length: 50 }).notNull(),
    url: varchar({ length: 2048 }).notNull(),
    discoveredVia: varchar('discovered_via', { length: 50 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    releaseGroupIdx: index('idx_review_links_release_group').on(table.releaseGroupId),
  })
);

export const providerCache = pgTable(
  'provider_cache',
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: varchar({ length: 50 }).notNull(),
    cacheKey: varchar('cache_key', { length: 512 }).notNull(),
    payload: jsonb().notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => ({
    providerKeyKey: uniqueIndex('provider_cache_provider_cache_key_key').on(
      table.provider,
      table.cacheKey
    ),
  })
);

// Curated layer (per library)

export const images = pgTable(
  'images',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: varchar({ length: 50 }).notNull(),
    origin: varchar({ length: 50 }).notNull(),
    imageSourceId: uuid('image_source_id').references(() => imageSources.id, {
      onDelete: 'set null',
    }),
    audioFileId: uuid('audio_file_id').references(() => audioFiles.id, { onDelete: 'set null' }),
    sidecarFileId: uuid('sidecar_file_id').references(() => sidecarFiles.id, {
      onDelete: 'set null',
    }),
    localPath: varchar('local_path', { length: 2048 }),
    width: integer(),
    height: integer(),
    bytes: text(),
    thumbBytes: customType<{ data: Buffer }>({ dataType: () => 'bytea' })('thumb_bytes'),
    localAlbumId: uuid('local_album_id').references(() => localAlbums.id, { onDelete: 'cascade' }),
    licenseNote: text('license_note').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_images_library').on(table.libraryId),
    entityIdx: index('idx_images_entity').on(table.entityType, table.entityId),
  })
);

export const matchCandidates = pgTable(
  'match_candidates',
  {
    id: uuid().primaryKey().defaultRandom(),
    localAlbumId: uuid('local_album_id')
      .notNull()
      .references(() => localAlbums.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    distance: numeric({ precision: 5, scale: 4 }).notNull(),
    breakdown: jsonb().default('{}'),
    source: varchar({ length: 50 }).notNull(),
    excluded: boolean().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    albumIdx: index('idx_match_candidates_album').on(table.localAlbumId),
  })
);

export const albumMatches = pgTable(
  'album_matches',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    localAlbumId: uuid('local_album_id')
      .notNull()
      .references(() => localAlbums.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    releaseGroupOnly: boolean('release_group_only').default(false),
    distance: numeric({ precision: 5, scale: 4 }).notNull(),
    status: varchar({ length: 20 }).notNull().default('auto'),
    decidedBy: varchar('decided_by', { length: 20 }).notNull().default('system'),
    reason: text(),
    /** provenance of the chosen candidate: mbid | mb_search | discogs_search | user_mbid | user_discogs (same vocabulary as match_candidates.source) */
    source: varchar({ length: 50 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_album_matches_library').on(table.libraryId),
    albumIdx: index('idx_album_matches_album').on(table.localAlbumId),
    liveIdx: uniqueIndex('idx_album_matches_live')
      .on(table.localAlbumId)
      .where(sql`status IN ('auto', 'confirmed')`),
  })
);

export const fieldLocks = pgTable(
  'field_locks',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    scope: varchar({ length: 20 }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    field: varchar({ length: 50 }).notNull(),
    value: jsonb(),
    reason: text(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_field_locks_library').on(table.libraryId),
    scopeIdx: index('idx_field_locks_scope').on(table.scope, table.scopeId),
  })
);

export const tagPlans = pgTable(
  'tag_plans',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: varchar({ length: 255 }).notNull(),
    scope: jsonb().notNull(),
    policy: jsonb().notNull(),
    status: varchar({ length: 20 }).notNull().default('draft'),
    stats: jsonb().default('{}'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => ({
    libraryIdx: index('idx_tag_plans_library').on(table.libraryId),
  })
);

export const tagPlanItems = pgTable(
  'tag_plan_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    tagPlanId: uuid('tag_plan_id')
      .notNull()
      .references(() => tagPlans.id, { onDelete: 'cascade' }),
    audioFileId: uuid('audio_file_id')
      .notNull()
      .references(() => audioFiles.id, { onDelete: 'cascade' }),
    before: jsonb().notNull(),
    after: jsonb().notNull(),
    diff: jsonb().notNull(),
    status: varchar({ length: 20 }).default('pending'),
    error: text(),
    audioHashBefore: varchar('audio_hash_before', { length: 64 }),
    audioHashAfter: varchar('audio_hash_after', { length: 64 }),
    sizeAfter: integer('size_after'),
    mtimeAfter: integer('mtime_after'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => ({
    planIdx: index('idx_tag_plan_items_plan').on(table.tagPlanId),
    fileIdx: index('idx_tag_plan_items_file').on(table.audioFileId),
    hashCheck: check(
      'tag_plan_items_audio_hash_check',
      sql`(status != 'applied' OR audio_hash_before = audio_hash_after)`
    ),
  })
);

export const followedArtists = pgTable(
  'followed_artists',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    mode: varchar({ length: 20 }).notNull().default('auto'),
    includePrimary: text('include_primary').array().default(sql`'{"Album"}'`),
    excludeSecondary: text('exclude_secondary')
      .array()
      .default(
        sql`'{"Compilation", "Live", "Remix", "DJ-mix", "Mixtape/Street", "Demo", "Soundtrack"}'`
      ),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_followed_artists_library').on(table.libraryId),
  })
);

export const gaps = pgTable(
  'gaps',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 50 }).notNull(),
    subjectType: varchar('subject_type', { length: 50 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    details: jsonb().default('{}'),
    state: varchar({ length: 20 }).notNull().default('open'),
    dismissReason: varchar('dismiss_reason', { length: 50 }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    libraryIdx: index('idx_gaps_library').on(table.libraryId),
    kindIdx: index('idx_gaps_kind').on(table.kind),
    // per-album open-gap probes from the grid facets and filters, 0017
    subjectIdx: index('idx_gaps_subject').on(table.subjectId, table.state),
  })
);

export const collectionSources = pgTable(
  'collection_sources',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    provider: varchar({ length: 50 }).notNull(),
    username: varchar({ length: 255 }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    syncCursor: jsonb('sync_cursor'),
    status: varchar({ length: 20 }),
    folders: jsonb().default('[]'),
    fields: jsonb().default('[]'),
    lastError: text('last_error'),
    itemCount: integer('item_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_collection_sources_library').on(table.libraryId),
  })
);

export const collectionItems = pgTable(
  'collection_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    collectionSourceId: uuid('collection_source_id')
      .notNull()
      .references(() => collectionSources.id, { onDelete: 'cascade' }),
    providerItemId: varchar('provider_item_id', { length: 255 }),
    discogsReleaseId: integer('discogs_release_id'),
    discogsMasterId: integer('discogs_master_id'),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    releaseGroupId: uuid('release_group_id').references(() => releaseGroups.id, {
      onDelete: 'set null',
    }),
    folderId: integer('folder_id'),
    folderName: varchar('folder_name', { length: 255 }),
    formats: jsonb().default('[]'),
    basicInfo: jsonb('basic_info'),
    mediaCondition: varchar('media_condition', { length: 50 }),
    sleeveCondition: varchar('sleeve_condition', { length: 50 }),
    rating: integer(),
    notes: text(),
    dateAdded: timestamp('date_added', { withTimezone: true }),
    mappingState: varchar('mapping_state', { length: 50 }).default('unmapped'),
    mappingSource: varchar('mapping_source', { length: 30 }),
    mappedAt: timestamp('mapped_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    pushState: varchar('push_state', { length: 20 }).default('synced'),
    pushError: text('push_error'),
    localAlbumId: uuid('local_album_id').references(() => localAlbums.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_collection_items_library').on(table.libraryId),
    mappingStateIdx: index('idx_collection_items_mapping_state').on(table.libraryId, table.mappingState),
    releaseGroupIdx: index('idx_collection_items_release_group').on(table.libraryId, table.releaseGroupId),
    pushStateIdx: index('idx_collection_items_push_state').on(table.libraryId, table.pushState),
    sourceItemUnique: uniqueIndex('collection_items_source_item_unique').on(table.collectionSourceId, table.providerItemId),
  })
);

export const wantlistItems = pgTable(
  'wantlist_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    collectionSourceId: uuid('collection_source_id')
      .notNull()
      .references(() => collectionSources.id, { onDelete: 'cascade' }),
    discogsReleaseId: integer('discogs_release_id'),
    releaseGroupId: uuid('release_group_id').references(() => releaseGroups.id, {
      onDelete: 'set null',
    }),
    dateAdded: timestamp('date_added', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_wantlist_items_library').on(table.libraryId),
  })
);

export const userReviews = pgTable(
  'user_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    rating: numeric({ precision: 2, scale: 1 }),
    bodyMd: text('body_md'),
    favoriteTrackIds: uuid('favorite_track_ids').array().default(sql`'{}'`),
    tags: text().array().default(sql`'{}'`),
    visibility: varchar({ length: 20 }),
    currentRevision: integer('current_revision').default(1),
    publishedTo: jsonb('published_to').default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_user_reviews_library').on(table.libraryId),
    releaseGroupIdx: index('idx_user_reviews_release_group').on(table.releaseGroupId),
  })
);

export const userReviewRevisions = pgTable(
  'user_review_revisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userReviewId: uuid('user_review_id')
      .notNull()
      .references(() => userReviews.id, { onDelete: 'cascade' }),
    revision: integer().notNull(),
    rating: numeric({ precision: 2, scale: 1 }),
    bodyMd: text('body_md'),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewIdx: index('idx_user_review_revisions_review').on(table.userReviewId),
  })
);

export const clippings = pgTable(
  'clippings',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    url: varchar({ length: 2048 }),
    sourceLabel: varchar('source_label', { length: 255 }),
    scoreRaw: numeric('score_raw', { precision: 5, scale: 2 }),
    note: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_clippings_library').on(table.libraryId),
  })
);

export const listens = pgTable(
  'listens',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    releaseGroupId: uuid('release_group_id')
      .notNull()
      .references(() => releaseGroups.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    listenedAt: timestamp('listened_at', { withTimezone: true }).notNull(),
    format: varchar({ length: 50 }),
    note: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_listens_library').on(table.libraryId),
    releaseGroupIdx: index('idx_listens_release_group').on(table.releaseGroupId),
  })
);

export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: varchar({ length: 255 }).notNull(),
    query: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_saved_views_library').on(table.libraryId),
  })
);

export const playerLinks = pgTable(
  'player_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: varchar({ length: 255 }).notNull(),
    urlTemplate: varchar('url_template', { length: 2048 }).notNull(),
    enabled: boolean().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_player_links_library').on(table.libraryId),
  })
);

export const credentials = pgTable(
  'credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    provider: varchar({ length: 50 }).notNull(),
    ciphertext: text().notNull(),
    nonce: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_credentials_library').on(table.libraryId),
    providerKey: uniqueIndex('idx_credentials_provider').on(table.libraryId, table.provider),
  })
);

export const settings = pgTable(
  'settings',
  {
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    key: varchar({ length: 100 }).notNull(),
    value: jsonb(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.libraryId, table.key] }),
  })
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar({ length: 50 }).notNull(),
    subjectType: varchar('subject_type', { length: 50 }),
    subjectId: uuid('subject_id'),
    payload: jsonb(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_audit_log_library').on(table.libraryId),
    atIdx: index('idx_audit_log_at').on(table.at),
  })
);

export const searchDocuments = pgTable(
  'search_documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    tsvectorContent: text('tsvector_content'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_search_documents_library').on(table.libraryId),
  })
);

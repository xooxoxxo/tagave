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
  smallint,
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

// Also Better Auth's user model (user.modelName "users", name -> display_name;
// see @tagave/auth). 0036 added email_verified .. two_factor_enabled.
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: varchar({ length: 255 }).notNull().unique(),
  displayName: varchar({ length: 255 }),
  // Legacy argon2id hash. Better Auth reads auth_accounts.password; this copy
  // is mirrored for rollback during the bridge release and dropped later.
  passwordHash: varchar({ length: 255 }),
  // owner | editor | listener (0043); setup names its owner explicitly.
  role: varchar({ length: 20 }).notNull().default('listener'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Cannot sign in while set (reversible). */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  /** Account closed with its data kept (0043). */
  removedAt: timestamp('removed_at', { withTimezone: true }),
  emailVerified: boolean('email_verified').notNull().default(true),
  image: text(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
});

// Better Auth tables (0036). Written by Better Auth through @tagave/auth; the
// app reads them only for Settings > Security and tagave-doctor.
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_accounts_provider_id_account_id_key').on(t.providerId, t.accountId),
    index('idx_auth_accounts_user').on(t.userId),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    token: text().notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_auth_sessions_user').on(t.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_auth_verifications_identifier').on(t.identifier)],
);

export const authPasskeys = pgTable(
  'auth_passkeys',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text(),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    counter: bigint({ mode: 'number' }).notNull().default(0),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    transports: text(),
    aaguid: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    // tagave's own: the PUBLIC_URL host (WebAuthn RP ID) it was registered for
    rpId: text('rp_id'),
  },
  (t) => [index('idx_auth_passkeys_user').on(t.userId)],
);

export const authTwoFactors = pgTable('auth_two_factors', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text().notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean().notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const authRateLimits = pgTable('auth_rate_limits', {
  id: uuid().primaryKey().defaultRandom(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// tagave's own: names the trusted-device verification rows (Settings > Security).
export const authTrustedDevices = pgTable(
  'auth_trusted_devices',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    identifier: text().notNull().unique(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_auth_trusted_devices_user').on(t.userId)],
);

// Step-up (0039): the last re-verification of a session for a sensitive
// action. A sign-in counts through auth_sessions.created_at.
export const authStepUps = pgTable(
  'auth_step_ups',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text().notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_auth_step_ups_user').on(t.userId)],
);

// Legacy (0.6.x) sessions: read only by the session bridge, dropped later.
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
  // Who created it. Every account reads every library (0043); deleting this
  // account is refused until the library is handed to someone else.
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
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
    /** 0052: normalized tag signature for Tier 2 move detection (helpers.coreTagsDigest) */
    coreTagsDigest: varchar('core_tags_digest', { length: 64 }),
    audioHash: varchar('audio_hash', { length: 64 }),
    audioHashAt: timestamp('audio_hash_at', { withTimezone: true }),
    fingerprint: varchar({ length: 255 }),
    fingerprintDuration: integer('fingerprint_duration'),
    status: varchar({ length: 20 }).notNull().default('present'),
    parseError: text('parse_error'),
    /** 0052: cluster.dir waits for Tier 2 on this row's folder (max one hour) */
    reconcileHoldAt: timestamp('reconcile_hold_at', { withTimezone: true }),
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
    librarySizeIdx: index('idx_audio_files_library_size').on(table.libraryId, table.sizeBytes),
    reconcileHoldIdx: index('idx_audio_files_reconcile_hold').on(table.scanRootId).where(sql`reconcile_hold_at is not null`),
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
    // 0026: when all local_tracks have been linked to canonical_tracks
    tracksLinkedAt: timestamp('tracks_linked_at', { withTimezone: true }),
    // 0029: set by "Treat as one album"; what "Split back" restores (see mergeAlbums.ts)
    mergedFrom: jsonb('merged_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_local_albums_library').on(table.libraryId),
    clusterKeyIdx: index('idx_local_albums_cluster_key').on(table.clusterKey),
    stateIdx: index('idx_local_albums_state').on(table.state),
    releaseGroupIdx: index('idx_local_albums_release_group_id').on(table.releaseGroupId),
    // 0025: cluster_key IS the album's identity within a library. Two sibling
    // folders of one multi-disc album can be clustered concurrently, and a
    // select-then-insert let both jobs miss and both insert. clusterDirJob
    // upserts on this index.
    libraryClusterKeyUniq: uniqueIndex('local_albums_library_cluster_key_uniq')
      .on(table.libraryId, table.clusterKey),
    // 0026: find albums needing track linking
    unlinkedIdx: index('idx_local_albums_unlinked')
      .on(table.libraryId)
      .where(sql`state = 'matched' and tracks_linked_at is null`),
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
    // 0026: FK reference to canonical_tracks; stable per (release, medium, position)
    canonicalTrackId: uuid('canonical_track_id').references(() => canonicalTracks.id, { onDelete: 'set null' }),
    recordingId: uuid('recording_id'),
    matchDistance: numeric('match_distance', { precision: 5, scale: 4 }),
    state: varchar({ length: 20 }).default('unmatched'),
    origin: varchar({ length: 10 }).notNull().default('file'),
    cueStartMs: integer('cue_start_ms'),
    cueRelPath: varchar('cue_rel_path', { length: 2048 }),
    // 0024: per-virtual-track Chromaprint for cue images (file-backed tracks use audio_files.fingerprint)
    fingerprint: text('fingerprint'),
    fingerprintDuration: integer('fingerprint_duration'),
    fingerprintedAt: timestamp('fingerprinted_at', { withTimezone: true }),
    fingerprintError: text('fingerprint_error'),
  },
  (table) => ({
    albumIdx: index('idx_local_tracks_album').on(table.localAlbumId),
    audioFileIdx: index('idx_local_tracks_audio_file').on(table.audioFileId),
    // 0026: index for finding linked tracks
    canonicalTrackIdx: index('idx_local_tracks_canonical_track').on(table.canonicalTrackId),
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
    // 0026: when canonical tracks had track_mbid ids refreshed from MB
    tracksRefreshedAt: timestamp('tracks_refreshed_at', { withTimezone: true }),
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
    // 0026: mediumNo is the track's identity within a release; always 1 for single-medium
    mediumNo: integer('medium_no').notNull().default(1),
    position: integer(),
    number: varchar({ length: 20 }),
    title: varchar({ length: 255 }).notNull(),
    artistCredit: jsonb('artist_credit'),
    recordingId: uuid('recording_id'),
    lengthMs: integer('length_ms'),
    isDataTrack: boolean('is_data_track').default(false),
    isVideo: boolean('is_video').default(false),
    // 0026: MusicBrainz recording and track mbids (36-char UUIDs)
    recordingMbid: varchar('recording_mbid', { length: 36 }),
    trackMbid: varchar('track_mbid', { length: 36 }),
  },
  (table) => ({
    releaseIdx: index('idx_canonical_tracks_release').on(table.releaseId),
    // 0026: canonical_track's identity: (release, medium, position) is stable across re-fetches
    uniqueIdx: uniqueIndex('canonical_tracks_release_medium_position_uniq')
      .on(table.releaseId, table.mediumNo, table.position),
    // 0026: fast lookup by recording mbid
    recordingMbidIdx: index('idx_canonical_tracks_recording_mbid').on(table.recordingMbid),
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
    // 0052: the origin CHECK forbids SET NULL
    audioFileId: uuid('audio_file_id').references(() => audioFiles.id, { onDelete: 'cascade' }),
    sidecarFileId: uuid('sidecar_file_id').references(() => sidecarFiles.id, {
      onDelete: 'cascade',
    }),
    localPath: varchar('local_path', { length: 2048 }),
    width: integer(),
    height: integer(),
    bytes: text(),
    /** Unused since 0046 (thumbnails live in cover_thumbs); dropped in the next release. */
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

/**
 * 300px JPEG thumbnail of an image (0046). Left out of every backup
 * (pg_dump --exclude-table-data): the worker rebuilds missing ones from the
 * originals on its cache volume (art.thumb).
 */
export const coverThumbs = pgTable(
  'cover_thumbs',
  {
    imageId: uuid('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    size: smallint().notNull().default(300),
    bytes: customType<{ data: Buffer }>({ dataType: () => 'bytea' })('bytes').notNull(),
    /** Content hash; the api's ETag. */
    sha256: customType<{ data: Buffer }>({ dataType: () => 'bytea' })('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.imageId, table.size] }),
  })
);

/** Limits of the cover rebuild across sweeps (0046): refetches a day, api sweep requests. */
export const coverRebuildLog = pgTable(
  'cover_rebuild_log',
  {
    id: bigint({ mode: 'number' }).primaryKey(),
    kind: text().notNull(),
    albumId: uuid('album_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindAtIdx: index('idx_cover_rebuild_log_kind_at').on(table.kind, table.at),
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

/** 0038: Review matches › Auto-accept rules, one row per library (no row = defaults, off). */
export const autoAcceptRules = pgTable('auto_accept_rules', {
  libraryId: uuid('library_id')
    .primaryKey()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  enabled: boolean().notNull().default(false),
  minMatch: integer('min_match').notNull().default(95),
  allChecksAgree: boolean('all_checks_agree').notNull().default(true),
  clearWinnerGap: integer('clear_winner_gap').notNull().default(5),
  preferSource: text('prefer_source').notNull().default('either'),
  officialOnly: boolean('official_only').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    /** 0031: the owner typed this name (rename); never rewritten automatically */
    nameByUser: boolean('name_by_user').notNull().default(false),
    scope: jsonb().notNull(),
    policy: jsonb().notNull(),
    status: varchar({ length: 20 }).notNull().default('draft'),
    stats: jsonb().default('{}'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** 0037: a finished plan the owner archived (hidden from the default list) */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    libraryIdx: index('idx_tag_plans_library').on(table.libraryId),
    libraryArchivedIdx: index('idx_tag_plans_library_archived').on(table.libraryId, table.archivedAt),
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
    // Mirrors migration 0023: 'applying' is the in-flight state tags.apply sets.
    statusCheck: check(
      'tag_plan_items_status_check',
      sql`status in ('pending', 'applying', 'applied', 'failed', 'skipped')`
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
    /** quality gaps: one row per flag (noCover, lowBitrate, …); '' for every other kind (0032) */
    flag: varchar({ length: 50 }).notNull().default(''),
    /** set when the owner chose "Add to my tasks"; kept after a scan resolves it, so it shows as done */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** the owner's note on a task */
    note: text(),
    /** when the owner last chose hide / wrong / task */
    decidedAt: timestamp('decided_at', { withTimezone: true }),
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
    /** the owner said they own this copy on top of an earlier one of the same release: not a duplicate */
    extraCopy: boolean('extra_copy').notNull().default(false),
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
    // 0050, owned by the wantlist (@tagave/db › wantlist.ts, wantlist.add): an
    // entry for an album with no release group here carries its names, and origin
    // records the module that added it (mc:<link id>)
    releaseGroupMbid: varchar('release_group_mbid', { length: 36 }),
    title: varchar({ length: 300 }),
    artist: varchar({ length: 300 }),
    origin: text(),
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
    /** manual (logged on the album page) | player (made from plays, 0044) */
    source: text().notNull().default('manual'),
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
    // Per person since 0043 (null only on rows an older version wrote).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: varchar({ length: 255 }).notNull(),
    query: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    libraryIdx: index('idx_saved_views_library').on(table.libraryId),
    userIdx: index('idx_saved_views_user').on(table.libraryId, table.userId),
  })
);

// Invite and set-password links from Settings › Users (0043). Only the
// SHA-256 of the token is stored.
export const userInvites = pgTable('user_invites', {
  id: uuid().primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  purpose: text().notNull(),
  email: varchar({ length: 255 }).notNull(),
  role: varchar({ length: 20 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  clearSecondFactors: boolean('clear_second_factors').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

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
    // null for per-person events such as Music Connections links (0047)
    libraryId: uuid('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
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

/**
 * One row per worker process, refreshed every 30 s (0027). Not per library:
 * workers run before the first library exists.
 */
export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    workerId: text('worker_id').primaryKey(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    info: jsonb().notNull().default('{}'),
  },
  (table) => ({
    seenAtIdx: index('idx_worker_heartbeats_seen_at').on(table.seenAt),
  })
);

/**
 * Outcome of an owner-requested identification (manual MBID / Discogs id,
 * release-group pick, re-identify), written by identify.album when it ends.
 * outcome: matched | needs_review | unidentified | release_group |
 * not_found | failed | cancelled | skipped.
 */
export const identifyRuns = pgTable(
  'identify_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    libraryId: uuid('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    localAlbumId: uuid('local_album_id').notNull().references(() => localAlbums.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id'),
    kind: text().notNull(),
    pinned: text(),
    outcome: text().notNull(),
    message: text().notNull(),
    detail: jsonb(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    albumIdx: index('idx_identify_runs_album').on(table.localAlbumId, table.finishedAt),
    jobIdx: index('idx_identify_runs_job').on(table.jobId),
  })
);

// The opt-in player module (0041). Empty while the module is off.

/** Which song on the player server is which local track (resolved on demand, cached). */
export const playerTrackMap = pgTable(
  'player_track_map',
  {
    localTrackId: uuid('local_track_id')
      .primaryKey()
      .references(() => localTracks.id, { onDelete: 'cascade' }),
    serverKey: text('server_key').notNull(),
    songId: text('song_id').notNull(),
    serverAlbumId: text('server_album_id'),
    serverPath: text('server_path'),
    /** path | recording | position */
    matchedBy: text('matched_by').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    serverIdx: index('idx_player_track_map_server').on(table.serverKey),
  })
);

/** What the web player reported (now_playing | completed | skipped); turned into listens and scrobbles later. */
export const playerEvents = pgTable(
  'player_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    localTrackId: uuid('local_track_id').references(() => localTracks.id, { onDelete: 'set null' }),
    localAlbumId: uuid('local_album_id').references(() => localAlbums.id, { onDelete: 'set null' }),
    releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
    recordingMbid: varchar('recording_mbid', { length: 36 }),
    serverKey: text('server_key'),
    serverSongId: text('server_song_id'),
    queueId: uuid('queue_id').notNull(),
    kind: text().notNull(),
    playedMs: integer('played_ms').notNull(),
    positionMs: integer('position_ms').notNull(),
    durationMs: integer('duration_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => ({
    userTimeIdx: index('idx_player_events_user_time').on(table.userId, table.occurredAt),
  })
);

/** Folders the player server should re-read, drained by the debounced player.scan job. */
export const playerScanRequests = pgTable(
  'player_scan_requests',
  {
    libraryId: uuid('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    /** relative to the music root; '' = the whole library */
    folder: text().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.libraryId, table.folder] }),
  })
);

// The player per person (0044). Written with raw SQL by the API (lib/player*.ts,
// lib/scrobbling.ts); mirrored here for reference and typed reads.

/** Each person's account on the player server (password sealed with APP_SECRET). */
export const playerUsers = pgTable(
  'player_users',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    serverKey: text('server_key').notNull(),
    username: text().notNull(),
    serverUserId: text('server_user_id'),
    passwordSealed: text('password_sealed').notNull(),
    /** managed (tagave made it) | person (their own login on the owner's server) */
    source: text().notNull(),
    phonePassword: boolean('phone_password').notNull().default(false),
    /** active | disabled */
    state: text().notNull().default('active'),
    serverScrobbles: boolean('server_scrobbles').notNull().default(false),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.userId, table.serverKey] }) })
);

/** Bundled-player accounts of people removed with their data, waiting to be locked on the server (0045). */
export const playerRetiredAccounts = pgTable(
  'player_retired_accounts',
  {
    serverKey: text('server_key').notNull(),
    username: text().notNull(),
    serverUserId: text('server_user_id'),
    retiredAt: timestamp('retired_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.serverKey, table.username] }) })
);

/** Each person's Last.fm session key / ListenBrainz token (sealed). */
export const scrobbleAccounts = pgTable(
  'scrobble_accounts',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** lastfm | listenbrainz */
    service: text().notNull(),
    accountName: text('account_name').notNull(),
    secretSealed: text('secret_sealed').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  },
  (table) => ({ pk: primaryKey({ columns: [table.userId, table.service] }) })
);

/** An album listen made from plays (>= half the tracks within 6 h). */
export const playerListens = pgTable('player_listens', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  libraryId: uuid('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
  localAlbumId: uuid('local_album_id').notNull().references(() => localAlbums.id, { onDelete: 'cascade' }),
  releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
  releaseGroupId: uuid('release_group_id').references(() => releaseGroups.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  tracksHeard: integer('tracks_heard').notNull(),
  tracksTotal: integer('tracks_total').notNull(),
  listenId: uuid('listen_id').references(() => listens.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One play of one track by one person; unique per (user, dedupe_key). */
export const playerPlays = pgTable('player_plays', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  libraryId: uuid('library_id').references(() => libraries.id, { onDelete: 'cascade' }),
  dedupeKey: text('dedupe_key').notNull(),
  /** web | server */
  source: text().notNull(),
  localTrackId: uuid('local_track_id').references(() => localTracks.id, { onDelete: 'set null' }),
  localAlbumId: uuid('local_album_id').references(() => localAlbums.id, { onDelete: 'set null' }),
  releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'set null' }),
  serverKey: text('server_key'),
  serverSongId: text('server_song_id'),
  title: text().notNull(),
  artist: text(),
  album: text(),
  albumArtist: text('album_artist'),
  trackNo: integer('track_no'),
  recordingMbid: varchar('recording_mbid', { length: 36 }),
  releaseMbid: varchar('release_mbid', { length: 36 }),
  durationMs: integer('duration_ms'),
  playedMs: integer('played_ms'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  heard: boolean().notNull(),
  scrobbles: boolean().notNull(),
  /** none | pending | done | failed */
  serverReport: text('server_report').notNull().default('none'),
  playerListenId: uuid('player_listen_id').references(() => playerListens.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One scrobble per play per service. */
export const playerScrobbles = pgTable(
  'player_scrobbles',
  {
    playId: uuid('play_id').notNull().references(() => playerPlays.id, { onDelete: 'cascade' }),
    service: text().notNull(),
    /** pending | sending | sent | ignored | failed */
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.playId, table.service] }) })
);

// Music Connections, phase 1 (0047): tagave as an OAuth 2.0 provider. Only
// SHA-256 hashes of secrets, codes and tokens are stored (api › lib/mcOAuth.ts).
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const mcOauthClients = pgTable('mc_oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecretHash: text('client_secret_hash').notNull(),
  name: text().notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  disabledAt: tstz('disabled_at'),
});

export const mcOauthRequests = pgTable(
  'mc_oauth_requests',
  {
    id: text().primaryKey(),
    clientId: text('client_id').notNull().references(() => mcOauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text().array().notNull(),
    state: text(),
    codeChallenge: text('code_challenge').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    decidedAt: tstz('decided_at'),
    codeHash: text('code_hash').unique(),
    codeExpiresAt: tstz('code_expires_at'),
    codeUsedAt: tstz('code_used_at'),
    familyId: uuid('family_id'),
  },
  (table) => ({ expiresIdx: index('idx_mc_oauth_requests_expires').on(table.expiresAt) })
);

export const mcOauthTokens = pgTable(
  'mc_oauth_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    familyId: uuid('family_id').notNull(),
    clientId: text('client_id').notNull().references(() => mcOauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scopes: text().array().notNull(),
    accessTokenHash: text('access_token_hash').notNull().unique(),
    accessExpiresAt: tstz('access_expires_at').notNull(),
    refreshTokenHash: text('refresh_token_hash').unique(),
    refreshExpiresAt: tstz('refresh_expires_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    rotatedAt: tstz('rotated_at'),
    revokedAt: tstz('revoked_at'),
  },
  (table) => ({
    familyIdx: index('idx_mc_oauth_tokens_family').on(table.familyId),
    userIdx: index('idx_mc_oauth_tokens_user').on(table.userId),
  })
);

// The facet change log (0048): which facet of which entity changed, in order.
// Written only by triggers (see the migration); read through @tagave/db ›
// facetLog.ts (the /mc/v1 feeds, in-process consumers), tombstones purged
// after 90 days by mc.purge.
export const facetChanges = pgTable(
  'facet_changes',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    facet: text().notNull(),
    key: text().notNull(),
    op: text().notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    sourceModule: text('source_module'),
    sourceRef: uuid('source_ref'),
    changedAt: tstz('changed_at').notNull().default(sql`clock_timestamp()`),
  },
  (table) => ({
    feedIdx: index('idx_facet_changes_feed').on(table.facet, table.userId, table.changedAt, table.id),
    keyIdx: index('idx_facet_changes_key').on(table.facet, table.key),
    tombstonesIdx: index('idx_facet_changes_tombstones').on(table.changedAt).where(sql`op = 'delete'`),
    facetCheck: check('facet_changes_facet_check', sql`facet in ('album.rating@1', 'album.collection@1', 'album.listens@1', 'album.identity@1')`),
    opCheck: check('facet_changes_op_check', sql`op in ('upsert', 'delete')`),
  })
);

// Where an in-process consumer stopped reading a facet (0048).
export const facetCursors = pgTable(
  'facet_cursors',
  {
    consumer: text().notNull(),
    facet: text().notNull(),
    scopeKey: text('scope_key').notNull().default(''),
    cursor: text().notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.consumer, table.facet, table.scopeKey] }) })
);

// Music Connections, tagave as a client (0049): one row per person and linked
// remote, and the authorizations in flight. Written by api ›
// routes/mcConnections.ts and worker › jobs/connectionsPull.ts; tokens and
// client secrets are sealed (APP_SECRET).
export const mcLinks = pgTable(
  'mc_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    remoteUrl: text('remote_url').notNull(),
    manifest: jsonb().notNull(),
    manifestCheckedAt: tstz('manifest_checked_at'),
    clientId: text('client_id').notNull(),
    sealedTokens: text('sealed_tokens').notNull().default(''),
    scopes: text().array().notNull().default(sql`'{}'`),
    requestedScopes: text('requested_scopes').array().notNull().default(sql`'{}'`),
    cursors: jsonb().notNull().default(sql`'{}'::jsonb`),
    handlerVersions: jsonb('handler_versions').notNull().default(sql`'{}'::jsonb`),
    // 0050: a snapshot in progress per capability; parked rows dropped over the cap
    snapshotSince: jsonb('snapshot_since').notNull().default(sql`'{}'::jsonb`),
    parkedDropped: integer('parked_dropped').notNull().default(0),
    state: text().notNull().default('active'),
    lastSyncAt: tstz('last_sync_at'),
    lastAttemptAt: tstz('last_attempt_at'),
    lastError: text('last_error'),
    failures: integer().notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    lastCounts: jsonb('last_counts'),
    pullLeaseUntil: tstz('pull_lease_until'),
    pullLeaseOwner: text('pull_lease_owner'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userRemote: uniqueIndex('mc_links_user_id_remote_url_key').on(table.userId, table.remoteUrl),
    dueIdx: index('idx_mc_links_due').on(table.nextAttemptAt).where(sql`state = 'active'`),
    stateCheck: check('mc_links_state_check', sql`state in ('active', 'needs_reapproval', 'revoked')`),
  })
);

// The gap-fill ledger (0050, core): a core fact a module filled; @tagave/db › identityFills.ts.
export const identityFills = pgTable(
  'identity_fills',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    entityId: uuid('entity_id').notNull().references(() => releaseGroups.id, { onDelete: 'cascade' }),
    field: text().notNull(),
    value: text().notNull(),
    module: text().notNull(),
    sourceRef: uuid('source_ref'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    confirmedAt: tstz('confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    entityField: uniqueIndex('identity_fills_kind_entity_id_field_key').on(table.kind, table.entityId, table.field),
    sourceIdx: index('idx_identity_fills_source').on(table.module, table.sourceRef),
    kindCheck: check('identity_fills_kind_check', sql`kind in ('album')`),
    fieldCheck: check('identity_fills_field_check', sql`field in ('mbid')`),
  })
);

// Music Connections, landed data (0050): one row per (link, remote key); the
// release group is null while parked. Written by worker › jobs/mcLanding.ts.
const mcLanded = {
  id: uuid().primaryKey().defaultRandom(),
  linkId: uuid('link_id').notNull().references(() => mcLinks.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text().notNull(),
  releaseGroupId: uuid('release_group_id').references(() => releaseGroups.id, { onDelete: 'set null' }),
  album: jsonb().notNull(),
  data: jsonb().notNull(),
  remoteUpdatedAt: tstz('remote_updated_at').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  lastTriedAt: tstz('last_tried_at'),
};

export const mcCriticScores = pgTable(
  'mc_critic_scores',
  { ...mcLanded },
  (table) => ({
    linkKey: uniqueIndex('mc_critic_scores_link_id_key_key').on(table.linkId, table.key),
    rgIdx: index('idx_mc_critic_scores_rg').on(table.releaseGroupId, table.userId),
    parkedIdx: index('idx_mc_critic_scores_parked').on(table.lastTriedAt).where(sql`release_group_id is null`),
  })
);

export const mcIdentity = pgTable(
  'mc_identity',
  { ...mcLanded, state: text().notNull() },
  (table) => ({
    linkKey: uniqueIndex('mc_identity_link_id_key_key').on(table.linkId, table.key),
    stateIdx: index('idx_mc_identity_state').on(table.state, table.lastTriedAt).where(sql`state in ('parked', 'awaiting_release')`),
    stateCheck: check('mc_identity_state_check', sql`state in ('parked', 'agrees', 'filled', 'conflict', 'suggested', 'awaiting_release', 'unresolved')`),
  })
);

export const mcWantlistSuggestions = pgTable(
  'mc_wantlist_suggestions',
  {
    ...mcLanded,
    decision: text(),
    decidedAt: tstz('decided_at'),
    wantlistItemId: uuid('wantlist_item_id').references(() => wantlistItems.id, { onDelete: 'set null' }),
  },
  (table) => ({
    linkKey: uniqueIndex('mc_wantlist_suggestions_link_id_key_key').on(table.linkId, table.key),
    userIdx: index('idx_mc_wantlist_user').on(table.userId, table.decision),
    parkedIdx: index('idx_mc_wantlist_parked').on(table.lastTriedAt).where(sql`release_group_id is null`),
    decisionCheck: check('mc_wantlist_suggestions_decision_check', sql`decision in ('accepted', 'dismissed')`),
  })
);

export const mcPending = pgTable(
  'mc_pending',
  {
    stateHash: text('state_hash').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    remoteUrl: text('remote_url').notNull(),
    manifest: jsonb().notNull(),
    clientId: text('client_id').notNull(),
    codeVerifierSealed: text('code_verifier_sealed').notNull(),
    clientSecretSealed: text('client_secret_sealed').notNull(),
    requestedScopes: text('requested_scopes').array().notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index('idx_mc_pending_created').on(table.createdAt),
  })
);

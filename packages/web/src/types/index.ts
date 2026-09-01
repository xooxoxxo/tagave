/**
 * API response types for the Liner web application
 * These complement the shared types and define API-specific structures
 */

import { SessionUser, Library, ScanRoot, ScanStats } from '@liner/shared';

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Library state with stats
 */
export interface LibraryState extends Library {
  stats?: {
    albumCount: number;
    trackCount: number;
    totalDurationMs: number;
    losslessShare: number; // 0-1
    storageBytesUsed: number;
  };
}

/**
 * Audio file representation - observed data only (M0)
 */
export interface AudioFile {
  id: string;
  libraryId: string;
  localAlbumId: string;
  path: string;
  filename: string;
  size: number;
  mtime: number; // Unix timestamp in ms
  container: string; // flac, mp3, m4a, ogg, opus, wav, aiff, ape, wv, dsf, dff
  codec: string;
  duration: number; // Seconds
  sampleRate: number; // Hz
  bitDepth?: number; // For lossless
  channels: number;
  averageBitrate: number; // bits/s
  hasEmbeddedArt: boolean;
  tags: Record<string, string | string[] | undefined>;
  status: 'ok' | 'error' | 'missing' | 'archived';
  errorMessage?: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

/**
 * Local album - cluster of files
 */
export interface LocalAlbum {
  id: string;
  libraryId: string;
  rootId: string;
  displayPath: string; // Relative to root
  fileCount: number;
  totalDuration: number; // Seconds
  files: AudioFile[];
  // Observed tags (as read from files)
  observedAlbum?: string;
  observedArtist?: string;
  observedAlbumArtist?: string;
  // Clustering metadata
  createdAt: string;
  updatedAt: string;
  // M1+: match info would go here
}

/**
 * Scan root with current status
 */
export interface ScanRootWithStatus extends ScanRoot {
  currentScanJobId?: string;
  albumsFound: number;
  tracksFound: number;
}

/**
 * Job run (from db)
 */
export interface JobRun {
  id: string;
  type: 'scan' | 'identify' | 'enrich' | 'tag_plan_apply' | 'collection_sync' | 'lint';
  status: 'pending' | 'running' | 'completed' | 'failed';
  libraryId: string;
  rootId?: string; // For scan jobs
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  progress?: {
    current: number;
    total: number;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  eta?: string; // ISO 8601 datetime
}

/**
 * Dashboard state
 */
export interface Dashboard {
  library: LibraryState;
  user: SessionUser;
  scanRoots: ScanRootWithStatus[];
  recentJobs: JobRun[];
  stats: {
    identifiedPercent: number; // 0-100
    lintPassPercent: number; // 0-100
    openGapsCount: number;
    reviewsWritten: number;
  };
}

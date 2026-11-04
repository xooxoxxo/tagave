/**
 * Naming rules and the drop pool (vault "tagave - Naming Rules and Drop
 * Pool"): the API shapes. The rendering is @tagave/core › naming.
 *
 *   GET  /libraries/:id/naming            NamingView (saved rules, or the ones detected from the library)
 *   PUT  /libraries/:id/naming            { rules } → NamingView
 *   POST /libraries/:id/naming/examples   { rules } → { examples } (unsaved rules, as the owner types)
 *   GET  /libraries/:id/drop-pool         DropPoolView
 *   PUT  /libraries/:id/drop-pool         { enabled, scanRootId?, dirPath? } → DropPoolView
 *   GET  /libraries/:id/organize          OrganizeView (albums whose paths differ from the rules)
 *   POST /libraries/:id/organize          { albumIds } → { queued } (one move each)
 *   GET  /libraries/:id/inbox             { items: InboxItem[] }
 *   POST /libraries/:id/inbox/:itemId     InboxAction → InboxItem
 */
import { z } from 'zod';

export const NAMING_SPECIAL_WHEN = ['soundtrack', 'compilation'] as const;

export const namingRulesSchema = z.object({
  folder: z.string().trim().min(1).max(400),
  file: z.string().trim().min(1).max(300),
  special: z.array(z.object({
    when: z.enum(NAMING_SPECIAL_WHEN),
    folder: z.string().trim().max(400),
  }).strict()).max(4),
  leaveAlone: z.array(z.string().trim().min(1).max(100)).max(50),
}).strict();

export type NamingRulesInput = z.infer<typeof namingRulesSchema>;

export const putNamingSchema = z.object({ rules: namingRulesSchema }).strict();

/** One example: a real song of the library, where it is and where the rules put it. */
export interface NamingExample {
  albumId: string;
  from: string;
  to: string;
}

export interface NamingView {
  rules: NamingRulesInput;
  /** the owner saved these rules (a tag plan then organizes by default) */
  saved: boolean;
  /** how the unsaved rules came about: the library's own pattern, or the default */
  detected: { matched: number; sampled: number; found: boolean } | null;
  examples: NamingExample[];
  /** per field ("folder", "file", "special.0"): why it cannot be used */
  problems: Record<string, string>;
}

/** The drop pool's default folder name, in the first writable music folder. */
export const DROP_POOL_DEFAULT_DIR = '_Inbox';

/** Seconds a dropped folder must stay unchanged before it is identified. */
export const DROP_POOL_STABLE_SECONDS = 120;

export const putDropPoolSchema = z.object({
  enabled: z.boolean(),
  scanRootId: z.string().uuid().optional(),
  dirPath: z.string().trim().min(1).max(500).optional(),
}).strict();

export type PutDropPool = z.infer<typeof putDropPoolSchema>;

export interface DropPoolView {
  enabled: boolean;
  scanRootId: string | null;
  /** relative to the music folder */
  dirPath: string | null;
  /** the folder as the file worker sees it */
  path: string | null;
  /** the folder as the computer that holds the music sees it (Lidarr's root folder), when known */
  hostPath: string | null;
  /** writable music folders the pool may be in */
  roots: Array<{ id: string; path: string }>;
  counts: { waiting: number; inbox: number; imported: number; skipped: number };
  /** why it cannot run now (no writable music folder) */
  problem: string | null;
}

/** Library care › Organize: one album whose paths differ from the rules. */
export interface OrganizeAlbum {
  albumId: string;
  title: string;
  artist: string | null;
  /** where its files are now (the folder most of them are in) */
  fromDir: string;
  /** where the rules put them */
  toDir: string;
  files: number;
  /** files whose name changes */
  renamed: number;
  /** one file, before and after */
  sample: { from: string; to: string } | null;
}

export interface OrganizeView {
  /** naming rules are saved: Organize follows them */
  saved: boolean;
  wrongFolder: OrganizeAlbum[];
  wrongNames: OrganizeAlbum[];
  /** albums in the right place */
  inPlace: number;
  /** albums under a Leave alone folder */
  leftAlone: number;
  /** more albums than the lists hold */
  truncated: boolean;
}

export const organizeRequestSchema = z.object({
  albumIds: z.array(z.string().uuid()).min(1).max(200),
}).strict();

export const INBOX_REASONS = ['unsure', 'unidentified', 'in_library', 'failed', 'undone'] as const;
export type InboxReason = (typeof INBOX_REASONS)[number];

export const POOL_STATES = ['waiting', 'identifying', 'inbox', 'importing', 'imported', 'skipped'] as const;
export type PoolState = (typeof POOL_STATES)[number];

/** One file of a dropped album as its tags read. */
export interface PoolFile {
  relPath: string;
  size: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  disc: number | null;
  track: number | null;
  durationMs: number | null;
}

/** A release identify found for a dropped album. */
export interface PoolCandidate {
  releaseId: string;
  mbid: string | null;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  format: string | null;
  tracks: number;
  /** 0–100 */
  percent: number;
}

/** How a file pairs with a track of the best release. */
export interface PoolPairing {
  relPath: string;
  disc: number | null;
  position: number | null;
  title: string | null;
  /** 0–100, null: no track */
  confidence: number | null;
}

export interface InboxItem {
  id: string;
  state: PoolState;
  reason: InboxReason | null;
  /** the album folder, relative to the pool */
  folder: string;
  files: number;
  best: PoolCandidate | null;
  candidates: PoolCandidate[];
  pairing: PoolPairing[];
  /** the library's album of the same release group (reason in_library) */
  existing: { albumId: string; title: string; artist: string | null; folder: string | null } | null;
  /** where the rules put it, with the best release */
  toDir: string | null;
  moveId: string | null;
  error: string | null;
  updatedAt: string;
}

export const inboxActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }).strict(),
  z.object({ action: z.literal('pick'), releaseMbid: z.string().uuid() }).strict(),
  z.object({ action: z.literal('skip') }).strict(),
  // Already in library
  z.object({ action: z.literal('replace') }).strict(),
  z.object({ action: z.literal('keepBoth') }).strict(),
]);
export type InboxAction = z.infer<typeof inboxActionSchema>;

export interface PoolScanJobData {
  /** one library; every library with a pool when absent (the schedule) */
  libraryId?: string;
  /** make the pool folder (the owner just turned the pool on) */
  create?: boolean;
  /** identify this item now, whatever its wait (an owner action) */
  itemId?: string;
}

export interface PoolImportJobData {
  itemId: string;
  /** the release to import as (accept: the best; pick: the owner's) */
  releaseId?: string;
  releaseMbid?: string;
  /** Already in library: the old copy to the trash first, or a second folder beside it */
  existing?: 'replace' | 'keepBoth';
}

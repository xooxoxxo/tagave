/**
 * Move to album (0080 album_moves): in the album page's Maintenance, songs
 * whose files sit in the wrong album's folder move, files and tags, into
 * another album's folder (an album of the library, or a MusicBrainz release
 * that has no folder yet). Owner only: it writes the music folder.
 *
 *   searching  the worker looks the artist and title up on MusicBrainz
 *   choosing   the releases it found wait for the owner to pick one
 *   planning   the worker pairs each file with a track of the target and
 *              works out its new path and its tag changes
 *   ready      the plan waits for Move
 *   moving     tags written, files moved, folders scanned
 *   done       Undo (and Library care › Moved) can put it all back
 *   undoing    → undone
 *   failed     stopped; nothing was kept
 */
import { z } from 'zod';
import type { TagDiffEntry } from './tagPlan.js';

/**
 * What a move moves (0081): songs into another album (Maintenance), an
 * album to the path its naming rules give (a tag plan, Library care ›
 * Organize), or a dropped album out of the drop pool into the library.
 */
export const ALBUM_MOVE_KINDS = ['move', 'organize', 'import'] as const;
export type AlbumMoveKind = (typeof ALBUM_MOVE_KINDS)[number];

export const ALBUM_MOVE_STATES = ['searching', 'choosing', 'planning', 'ready', 'moving', 'done', 'undoing', 'undone', 'failed'] as const;
export type AlbumMoveState = (typeof ALBUM_MOVE_STATES)[number];

/** Where the songs go: an album of the library, a MusicBrainz release, or a search for one. */
export const moveTargetSchema = z.union([
  z.object({ albumId: z.string().uuid() }).strict(),
  z.object({ releaseMbid: z.string().uuid() }).strict(),
  z.object({ search: z.object({ artist: z.string().trim().max(200), title: z.string().trim().min(1).max(200) }).strict() }).strict(),
]);
export type MoveTarget = z.infer<typeof moveTargetSchema>;

/** POST /libraries/:id/albums/:albumId/moves */
export const createMoveSchema = z.object({
  trackIds: z.array(z.string().uuid()).min(1).max(500),
  target: moveTargetSchema,
}).strict();
export type CreateMoveRequest = z.infer<typeof createMoveSchema>;

/** POST …/moves/:moveId/target: pick (or change) the target of a move not yet made. */
export const moveTargetUpdateSchema = z.object({ target: moveTargetSchema }).strict();

/** One release the MusicBrainz search found. */
export interface MoveCandidate {
  mbid: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  format: string | null;
  tracks: number;
  /** a local album already holds this release: moving there means that album */
  localAlbumId: string | null;
}

/** One file of the plan. */
export interface MovePlanFile {
  /** null: a file not in the library yet (a drop pool import) */
  fileId: string | null;
  localTrackId: string | null;
  /** the song as it is now */
  title: string;
  /** relative to its root, now and after */
  fromPath: string;
  toPath: string | null;
  /** the target's track it pairs with (null: not on the target, it stays) */
  target: { canonicalTrackId: string; disc: number; position: number; title: string } | null;
  /** 0–100, from the alignment's distance */
  confidence: number | null;
  /** the tag changes (album and track fields of the target) */
  diff: TagDiffEntry[];
  /** why it stays, when it does */
  stays: string | null;
  /** its new name is taken (on disk, or by another moved file): the move cannot start */
  clash: boolean;
}

export interface MovePlan {
  /** the root the files move within */
  scanRootId: string;
  /** the target folder, relative to the root */
  toDir: string;
  /** the folder does not exist yet */
  newFolder: boolean;
  /** what the file names follow: "NN - Title.ext", or the target folder's own */
  naming: string;
  release: { id: string; mbid: string | null; title: string; artist: string; year: number | null; tracks: number };
  files: MovePlanFile[];
  /** covers, cue sheets, logs and other files of the album's folder that go with it (organize, import) */
  extras?: Array<{ fromPath: string; toPath: string }>;
  /** the folder the emptied folders are trashed up to, never past (organize, import) */
  keepDir?: string;
}

/** What a move did, for Undo: per file its paths and the tags before and after. */
export interface MoveJournalFile {
  /** null: a file not in the library when it moved (a drop pool import) */
  fileId: string | null;
  fromPath: string;
  toPath: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: TagDiffEntry[];
  /** tags written (Undo writes them back) */
  tagged: boolean;
  /** file renamed (Undo moves it back) */
  moved: boolean;
}

export interface MoveJournal {
  scanRootId: string;
  files: MoveJournalFile[];
  /** the source folder went to the trash, empty (relative to the root) */
  trashedDir: { dir: string; trashRelPath: string } | null;
  /** more emptied folders, each in the trash (organize, import) */
  trashedDirs?: Array<{ dir: string; trashRelPath: string }>;
  /** the companion files moved, and whether each is moved now */
  extras?: Array<{ fromPath: string; toPath: string; moved: boolean }>;
  /** the target folder was made by the move */
  madeDir: string | null;
  /** file-to-album pins the move lifted (Undo puts them back) */
  pins: Array<{ audioFileId: string; localAlbumId: string | null }>;
}

export interface AlbumMoveView {
  id: string;
  state: AlbumMoveState;
  sourceAlbumId: string | null;
  targetAlbumId: string | null;
  candidates: MoveCandidate[] | null;
  plan: MovePlan | null;
  /** moved files (done), or null */
  moved: number | null;
  error: string | null;
  /** Undo is still possible */
  undoable: boolean;
  /** why Move cannot start now (the folder is read-only, tag writes are off), or null */
  blocked: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** GET …/moves/albums?q=: the picker's albums. */
export interface MoveAlbumOption {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  tracks: number;
  folder: string | null;
  matched: boolean;
}

/** Library care › Moved: one finished move. */
export interface MoveListItem {
  id: string;
  kind: AlbumMoveKind;
  state: AlbumMoveState;
  title: string;
  artist: string | null;
  fromDir: string | null;
  toDir: string | null;
  files: number;
  targetAlbumId: string | null;
  finishedAt: string | null;
  undoable: boolean;
  error: string | null;
}

export interface FilesMoveJobData {
  moveId: string;
  action: 'search' | 'plan' | 'move' | 'undo';
}

/** Pairs weaker than this are flagged in the preview. */
export const MOVE_LOW_CONFIDENCE = 65;

/** The preview's confidence from an alignment distance (0 = title and length agree). */
export function moveConfidence(distance: number): number {
  return Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
}

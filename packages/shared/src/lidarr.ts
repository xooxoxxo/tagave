/**
 * Get missing albums through Lidarr (the lidarr module, 0075; vault "tagave
 * - Get Missing Albums", part B). What the API answers and accepts. The API
 * key is sent, never answered: the settings say only whether one is saved.
 */
import { z } from 'zod';

export const LIDARR_REQUEST_STATES = ['wanted', 'downloading', 'imported', 'done', 'not_found'] as const;
export type LidarrRequestState = (typeof LIDARR_REQUEST_STATES)[number];

/** One word each, on the card and the Getting list. */
export const LIDARR_STATE_LABELS: Readonly<Record<LidarrRequestState, string>> = {
  wanted: 'Wanted',
  downloading: 'Downloading',
  imported: 'Importing',
  done: 'In library',
  not_found: 'Not found',
};

const lidarrUrl = z.string().trim().min(1).max(2048).refine((s) => /^https?:\/\//i.test(s), { message: 'Use an http or https address' });
const apiKey = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._-]+$/, { message: 'Not an API key' });

/** POST /settings/lidarr/test: an empty key uses the saved one (same address only). */
export const lidarrTestSchema = z.object({ url: lidarrUrl, apiKey: apiKey.optional() }).strict();
export type LidarrTestRequest = z.infer<typeof lidarrTestSchema>;

const absolutePath = z.string().trim().min(1).max(1024).refine((s) => s.startsWith('/') && !s.split('/').includes('..'), { message: 'Use an absolute path' });

/** "Lidarr sees the music folder as": the path in Lidarr's container that is this music folder. */
export const lidarrPathMapSchema = z.object({ lidarrPath: absolutePath, scanRootId: z.string().uuid() }).strict();
export type LidarrPathMapInput = z.infer<typeof lidarrPathMapSchema>;

/**
 * PUT /settings/lidarr/connection: tested again before it is saved. With
 * useDropPool the root folder is the drop pool (made in Lidarr when it has
 * none there), else the root folder picked from Lidarr's.
 */
export const lidarrConnectionSchema = z.object({
  url: lidarrUrl,
  apiKey: apiKey.optional(),
  rootFolderPath: z.string().min(1).max(1024).optional(),
  qualityProfileId: z.number().int().nonnegative(),
  metadataProfileId: z.number().int().nonnegative(),
  useDropPool: z.boolean().optional(),
  pathMap: lidarrPathMapSchema.nullable().optional(),
}).strict().refine((b) => b.useDropPool === true || !!b.rootFolderPath, { message: 'Pick a root folder', path: ['rootFolderPath'] });
export type LidarrConnectionRequest = z.infer<typeof lidarrConnectionSchema>;

export const lidarrModuleSchema = z.object({ enabled: z.boolean() }).strict();

export const lidarrGetSchema = z.object({ releaseGroupId: z.string().uuid() }).strict();

export interface LidarrChoice {
  id: number;
  name: string;
}

/** What Test found: the version and what the selects offer. */
export interface LidarrTestResult {
  version: string;
  rootFolders: string[];
  qualityProfiles: LidarrChoice[];
  metadataProfiles: LidarrChoice[];
}

/** Settings › Modules › Lidarr (owner). */
export interface LidarrSettingsView {
  enabled: boolean;
  connection: {
    url: string;
    keySaved: boolean;
    /** the saved key does not open with this APP_SECRET: enter it again */
    keyUnreadable: boolean;
    rootFolderPath: string;
    qualityProfileId: number;
    metadataProfileId: number;
    version: string | null;
    qualityProfileName: string | null;
    metadataProfileName: string | null;
    /** the root folder is the drop pool (on by default while the pool is on) */
    useDropPool: boolean;
    pathMap: LidarrPathMapInput | null;
  } | null;
  /** tagave's music folders, for the warning */
  scanRoots: string[];
  /** the same, with their ids and host paths (the mapping's music folder) */
  musicFolders: Array<{ id: string; path: string; hostPath: string | null }>;
  /** the drop pool while it is on: its folder in tagave, and as Lidarr sees it (with the saved mapping) */
  pool: { scanRootId: string; dirPath: string; path: string; lidarrPath: string } | null;
  /** an album Lidarr imported is in none of them (or the root folder is not) */
  rootFolderOutside: boolean;
  /** requests not done yet */
  open: number;
}

export const LIDARR_REACH_STATES = ['writable', 'unseen', 'readonly'] as const;
export type LidarrReachState = (typeof LIDARR_REACH_STATES)[number];

/** POST /settings/lidarr/root-folder: the root folder made when it should be, and what Lidarr can do there. */
export interface LidarrRootCheckView {
  /** null: not connected, or Lidarr did not answer */
  reach: LidarrReachState | null;
  /** the root folder as Lidarr sees it */
  path: string | null;
  /** where Lidarr's container needs the music share: the music folder as Lidarr sees it */
  mountPath: string | null;
  /** Lidarr did not answer: its one line */
  error: string | null;
}

/** The one line under the root folder. */
export function lidarrReachLine(reach: LidarrReachState, mountPath: string | null): string {
  if (reach === 'writable') return 'Lidarr can write here';
  if (reach === 'readonly') return 'Lidarr can see it but can’t write';
  return mountPath
    ? `Lidarr can’t see this folder: mount the music share into Lidarr’s container at ${mountPath}`
    : 'Lidarr can’t see this folder';
}

/** GET /lidarr: may this person Get, and is it set up. */
export interface LidarrStatusView {
  /** on and connected */
  available: boolean;
  /** available, and this person may Get (owner) */
  canGet: boolean;
}

export interface LidarrRequestView {
  id: string;
  releaseGroupId: string;
  state: LidarrRequestState;
  progress: number | null;
  error: string | null;
  requestedAt: string;
}

/** The artist page: each missing album's request, and which albums Get can ask for. */
export interface ArtistLidarrView {
  available: boolean;
  canGet: boolean;
  /** by release group id */
  requests: Record<string, LidarrRequestView>;
  /** missing albums Lidarr can be asked for (the album and its artist have MusicBrainz ids) */
  gettable: string[];
}

/** Library care › Getting: a request with its album's names. */
export interface LidarrGettingItem extends LidarrRequestView {
  title: string;
  artist: string | null;
  artistId: string | null;
}

export interface LidarrGettingView {
  available: boolean;
  items: LidarrGettingItem[];
}

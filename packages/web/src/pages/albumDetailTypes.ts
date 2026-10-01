/** The album detail as GET /libraries/:id/albums/:albumId returns it. */
import type { IdentifyRequestView } from '@liner/shared';

/** another album with this title that fits together with this one */
export interface MergeCandidateView {
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  trackCount: number | null;
  state: string;
  dirPaths: string[];
}

export interface DetailTrack {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  title: string | null;
  /** the track's own artist tag; on a compilation it differs per track */
  artist?: string | null;
  durationMs: number | null;
  origin: string;
  cueStartMs: number | null;
  canonicalTitle: string | null;
  canonicalDurationMs: number | null;
  file: {
    relPath: string;
    codec: string | null;
    lossless: boolean | null;
    bitrateKbps: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    sizeBytes: number | null;
    status: string;
  };
}
export interface Candidate {
  id: string;
  releaseMbid: string | null;
  discogsReleaseId: number | null;
  title: string;
  artistCredit: string;
  date: string | null;
  country: string | null;
  status: string | null;
  trackCount: number | null;
  distance: number;
  source: string;
  provider: string;
  rgMbid: string | null;
  excluded: boolean;
  /** media summary and first label/catno — present once the detail handler ships them */
  format?: string | null;
  label?: string | null;
  /** the release's tracks (API ≥ 0.4.2), for the per-track length comparison */
  tracks?: CandidateTrack[];
}
export interface CandidateTrack {
  disc: number;
  position: number | null;
  title: string;
  lengthMs: number | null;
}
export interface PendingIdentify {
  id: string;
  state: 'created' | 'retry' | 'active';
  kind: 'mbid' | 'release_group' | 'discogs' | 'reidentify' | 'sweep';
  pinned: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  jobsAhead: number;
}
export interface Gap {
  id: string;
  kind: string;
  /** open | todo (on the task list) | dismissed | resolved (a task a scan crossed out) */
  state: string;
  dismissReason: string | null;
  details: Record<string, unknown>;
  /** quality gaps: the one flag this row stands for (0032) */
  flag?: string;
  acceptedAt?: string | null;
  resolvedAt?: string | null;
  note?: string | null;
}
export interface DiscogsCollectionItem {
  id: string;
  folder: string;
  /** "CD", "2×Vinyl"; null until Discogs answers */
  format?: string | null;
  discogsReleaseId?: number;
  mediaCondition?: string;
  sleeveCondition?: string;
  rating?: number;
  pushState?: string;
  pushError?: string;
}

export interface AlbumDetail {
  id: string;
  releaseGroupId: string | null;
  title: string | null;
  artistCredit: string | null;
  year: number | null;
  state: string;
  dirPaths: string[];
  formats: string[];
  discCount: number | null;
  trackCount: number | null;
  totalDurationMs: number | null;
  coverUrl: string | null;
  /** the one queued identify job for this album, if any (manual pin, re-identify or the sweep) */
  pendingIdentify?: PendingIdentify | null;
  /** the owner's latest request: live job state, or how it ended (absent on an older API) */
  identifyRequest?: IdentifyRequestView | null;
  coverOrigin: string | null;
  /** the latest cover-art lookup (API ≥ 0.6): live while queued or running */
  artFetch?: { state: 'queued' | 'running' | 'done' | 'failed'; finishedAt: string | null } | null;
  /** each folder with its scan root and "Open folder" link (API ≥ 0.6) */
  folders?: Array<{ path: string; scanRootId: string | null; link: string | null }>;
  isCueImage: boolean;
  cueRelPath: string | null;
  /** the folder mixes lossless and lossy files (XO-364: can be split by format) */
  mixed: boolean;
  /** set on an album split off another one; "Merge back" returns the files */
  splitFrom: string | null;
  /** built by "Treat as one album"; can be split back */
  merged?: boolean;
  /** other albums with this title that fit together with this one */
  mergeCandidates?: MergeCandidateView[];
  artists?: Array<{ id: string; name: string; position: number }>;
  genres?: {
    effective: string[];
    styles: string[];
    raw: Array<{ tag: string; kind: string; source: string; weight?: number | null }>;
  };
  release: {
    mbid: string | null;
    title: string;
    date: string | null;
    country: string | null;
    status: string | null;
    labels: { name: string; catno?: string }[] | null;
    trackCount: number | null;
    artistCredit: string[] | string | null;
    discogsReleaseId: number | null;
    discogsMasterId: number | null;
    sourceOfTruth: string;
    externalLinks: Array<{ title: string; url: string; source: string }>;
    genres?: string[];
    styles?: string[];
    fetchedAt: string | null;
  } | null;
  match: {
    status: string;
    decidedBy: string;
    distance: number;
    decidedAt: string | null;
    reason: string | null;
    releaseGroupOnly?: boolean;
  } | null;
  discogsCollectionItems?: DiscogsCollectionItem[];
  editions?: {
    fetchedAt: string | null;
    releaseGroupMbid: string;
    editions: Array<{
      releaseId: string;
      mbid: string;
      title: string;
      status?: string | null;
      date?: string | null;
      country?: string | null;
      barcode?: string | null;
      packaging?: string | null;
      labels: Array<{ name: string; catalogNumber?: string | null }>;
      media: Array<Record<string, unknown>>;
      trackCount: number;
      owned: boolean;
      ownedByOtherAlbums: number;
    }>;
  } | null;
  tracks: DetailTrack[];
  missingTracks: { disc: number; position: number; title: string; lengthMs: number | null }[];
  gaps: Gap[];
  candidates: Candidate[];
  duplicates: {
    id: string;
    title: string | null;
    artist: string | null;
    trackCount: number | null;
    formats: string[] | null;
    state: string;
    dirPaths: string[] | null;
  }[];
}


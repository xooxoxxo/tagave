/**
 * Match evidence: what identification saw when it scored an album against its
 * candidates. Reviewers read it, and the decider is sent it (with titles and
 * years taken from file or folder names replaced by placeholders, which is why
 * every local title and the year keep their source).
 *
 * Compact by design: the local album and its tracks are stored once per album
 * (AlbumEvidence); each candidate stores only its remote facts, its tracklist
 * and the alignment as index triples (CandidateEvidence). Nothing derived
 * from a path is stored except the source label of a value.
 */
import { createHash } from 'node:crypto';
import { MAX_ALIGN_TRACKS, type ReleaseScore } from './scoring.js';

export const EVIDENCE_VERSION = 1;

/**
 * Where a local title came from: a tag (or the cue sheet), the file name, the
 * folder name (an album without album tags is titled after its folder), or
 * nowhere.
 */
export type TitleSource = 'tag' | 'filename' | 'folder' | 'none';
/** Where the album year came from: a tag (or the cue sheet), or the folder name. */
export type YearSource = 'tag' | 'folder';

export interface LocalTrackEvidence { i: number; disc: number | null; title: string; titleSource: TitleSource | null; durS: number | null }
export interface AlbumEvidence {
  v: 1;
  artist: string;
  title: string;
  titleSource: TitleSource | null;
  year: number | null;
  yearSource: YearSource | null;
  discsKnown: boolean;
  discCount: number | null;
  tracks: LocalTrackEvidence[];
}
export interface RemoteFacts { provider: 'musicbrainz' | 'discogs'; title: string; artists: string[]; year: number | null; country: string | null; label: string | null; catalogNumber: string | null; barcode: string | null; media: string | null; mediumCount: number | null; status: string | null }
export type RemoteTrack = [medium: number | null, title: string, durS: number | null];
export type AlignTriple = [local: number, remote: number, distance: number];
export interface CandidateEvidence { v: 1; remote: RemoteFacts; tracks: RemoteTrack[]; align: AlignTriple[]; unmatchedLocal: number[]; missingRemote: number[]; capped: boolean }
export interface AlbumEvidenceInput {
  artist: string;
  title: string;
  /** source of the album title; omitted means unknown */
  titleSource?: TitleSource | null | undefined;
  year: number | null;
  yearSource: YearSource | null;
  discsKnown: boolean;
  discCount: number | null;
  tracks: Array<{ disc?: number | undefined; title: string; titleSource: TitleSource | null; duration: number }>;
}
export interface RemoteInput { source: 'musicbrainz' | 'discogs'; title: string; artists: string[]; year?: number | undefined; country?: string | undefined; barcode?: string | undefined; label?: string | undefined; catalogNumber?: string | undefined; media?: string | undefined; status?: string | null | undefined; mediumCount?: number | undefined; tracks: Array<{ title: string; duration: number; medium?: number | undefined }> }
export interface EvidenceCandidate { releaseId: string; distance: number; acoustidCoverage: number | null; evidence: CandidateEvidence | null }

/** Seconds, rounded; 0 (or anything unusable) means unknown. */
const secs = (d: number): number | null => (Number.isFinite(d) && d > 0 ? Math.round(d) : null);
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const round4OrNull = (x: number | null): number | null => (x === null ? null : round4(x));

export function buildAlbumEvidence(input: AlbumEvidenceInput): AlbumEvidence {
  return {
    v: EVIDENCE_VERSION,
    artist: input.artist, title: input.title, titleSource: input.titleSource ?? null,
    year: input.year, yearSource: input.yearSource,
    discsKnown: input.discsKnown, discCount: input.discCount,
    tracks: input.tracks.map((t, i) => ({ i, disc: t.disc ?? null, title: t.title, titleSource: t.titleSource, durS: secs(t.duration) })),
  };
}

/**
 * Evidence for one candidate, from exactly what the scorer aligned. The
 * remote track index in a triple is the candidate track's position in
 * `remote.tracks` (the scorer's canonical index). `capped` uses the scorer's
 * own cap: over it, the scorer aligns nothing and neither does the evidence.
 */
export function buildCandidateEvidence(remote: RemoteInput, score: Pick<ReleaseScore, 'alignment' | 'missingRemote'>, localTrackCount: number): CandidateEvidence {
  const align: AlignTriple[] = [];
  const unmatchedLocal: number[] = [];
  for (const a of score.alignment) {
    if (a.canonicalIndex === null) unmatchedLocal.push(a.localIndex);
    else align.push([a.localIndex, a.canonicalIndex, round4(a.distance)]);
  }
  return {
    v: EVIDENCE_VERSION,
    remote: {
      provider: remote.source, title: remote.title, artists: [...remote.artists],
      year: remote.year ?? null, country: remote.country ?? null, label: remote.label ?? null,
      catalogNumber: remote.catalogNumber ?? null, barcode: remote.barcode ?? null, media: remote.media ?? null,
      mediumCount: remote.mediumCount ?? null, status: remote.status ?? null,
    },
    tracks: remote.tracks.map((t): RemoteTrack => [t.medium ?? null, t.title, secs(t.duration)]),
    align,
    unmatchedLocal,
    missingRemote: [...score.missingRemote],
    capped: Math.max(localTrackCount, remote.tracks.length) > MAX_ALIGN_TRACKS,
  };
}

/** JSON with object keys sorted at every level: equal content, equal text. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

// The hash reads the typed fields one by one, so extra properties a caller's
// object happens to carry (a candidate row id, timestamps, flags) never reach it.
function albumHashView(a: AlbumEvidence) {
  return {
    v: a.v, artist: a.artist, title: a.title, titleSource: a.titleSource,
    year: a.year, yearSource: a.yearSource, discsKnown: a.discsKnown, discCount: a.discCount,
    tracks: a.tracks.map((t) => [t.i, t.disc, t.title, t.titleSource, t.durS]),
  };
}

function candidateEvidenceHashView(e: CandidateEvidence) {
  const r = e.remote;
  return {
    v: e.v,
    remote: {
      provider: r.provider, title: r.title, artists: r.artists, year: r.year, country: r.country,
      label: r.label, catalogNumber: r.catalogNumber, barcode: r.barcode, media: r.media,
      mediumCount: r.mediumCount, status: r.status,
    },
    tracks: e.tracks.map((t) => [t[0], t[1], t[2]]),
    align: e.align.map((t) => [t[0], t[1], round4(t[2])]),
    unmatchedLocal: e.unmatchedLocal, missingRemote: e.missingRemote, capped: e.capped,
  };
}

/**
 * What a decision was made on: the album's facts and its candidates (by
 * release, order-free). Covers every field of AlbumEvidence (sources too: they
 * decide what the decider is sent), and per candidate its release id, distance
 * and AcoustID coverage (both to 4 decimals) and every field of its evidence.
 * Nothing else: no candidate row id, no timestamps, no property outside these
 * types, and object key order and candidate order do not matter.
 */
export function evidenceHash(album: AlbumEvidence, candidates: EvidenceCandidate[]): string {
  const sorted = [...candidates].sort((a, b) => (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0))
    .map((c) => ({
      r: c.releaseId, d: round4(c.distance), a: round4OrNull(c.acoustidCoverage),
      e: c.evidence === null ? null : candidateEvidenceHashView(c.evidence),
    }));
  return createHash('sha256').update(stableJson({ album: albumHashView(album), candidates: sorted })).digest('hex');
}

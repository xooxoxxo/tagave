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
  const remoteCount = remote.tracks.length;
  const capped = Math.max(localTrackCount, remoteCount) > MAX_ALIGN_TRACKS;
  const align: AlignTriple[] = [];
  const unmatchedLocal: number[] = [];
  for (const a of score.alignment) {
    if (a.canonicalIndex === null) {
      unmatchedLocal.push(a.localIndex);
      continue;
    }
    if (!(Number.isInteger(a.localIndex) && a.localIndex >= 0 && a.localIndex < localTrackCount)) {
      throw new RangeError(`evidence: local track index ${a.localIndex} outside 0..${localTrackCount - 1}`);
    }
    if (!(Number.isInteger(a.canonicalIndex) && a.canonicalIndex >= 0 && a.canonicalIndex < remoteCount)) {
      throw new RangeError(`evidence: remote track index ${a.canonicalIndex} outside 0..${remoteCount - 1}`);
    }
    align.push([a.localIndex, a.canonicalIndex, round4(a.distance)]);
  }
  // Over the cap the scorer aligns nothing; an alignment here means the track
  // count given does not match what was scored.
  if (capped && align.length > 0) {
    throw new RangeError(`evidence: ${align.length} aligned tracks on a candidate over the ${MAX_ALIGN_TRACKS}-track cap`);
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
    capped,
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
// A nullable field read back without its key (jsonb written by another
// version) hashes as null. Any number that is not finite throws: JSON would
// write it as null, so NaN and null would collide, and a NaN distance is a
// scorer bug that must not be stored as a decision fact.
function finite(x: number, what: string): number {
  if (!Number.isFinite(x)) throw new RangeError(`evidence hash: ${what} is not a finite number (${x})`);
  return x;
}
function finiteOrNull(x: number | null | undefined, what: string): number | null {
  return x === null || x === undefined ? null : finite(x, what);
}

function albumHashView(a: AlbumEvidence) {
  return {
    v: a.v, artist: a.artist, title: a.title, titleSource: a.titleSource ?? null,
    year: finiteOrNull(a.year, 'album year'), yearSource: a.yearSource ?? null,
    discsKnown: a.discsKnown, discCount: finiteOrNull(a.discCount, 'disc count'),
    tracks: a.tracks.map((t) => [finite(t.i, 'local track index'), finiteOrNull(t.disc, 'local disc'), t.title,
      t.titleSource ?? null, finiteOrNull(t.durS, 'local duration')]),
  };
}

function candidateEvidenceHashView(e: CandidateEvidence) {
  const r = e.remote;
  return {
    v: e.v,
    remote: {
      provider: r.provider, title: r.title, artists: r.artists, year: finiteOrNull(r.year, 'remote year'),
      country: r.country ?? null, label: r.label ?? null, catalogNumber: r.catalogNumber ?? null,
      barcode: r.barcode ?? null, media: r.media ?? null,
      mediumCount: finiteOrNull(r.mediumCount, 'medium count'), status: r.status ?? null,
    },
    tracks: e.tracks.map((t) => [finiteOrNull(t[0], 'remote medium'), t[1], finiteOrNull(t[2], 'remote duration')]),
    align: e.align.map((t) => [finite(t[0], 'aligned local index'), finite(t[1], 'aligned remote index'),
      round4(finite(t[2], 'track distance'))]),
    unmatchedLocal: e.unmatchedLocal.map((i) => finite(i, 'unmatched local index')),
    missingRemote: e.missingRemote.map((i) => finite(i, 'missing remote index')),
    capped: e.capped,
  };
}

/**
 * What a decision was made on: the album's facts and its candidates (by
 * release, order-free). Covers every field of AlbumEvidence (sources too: they
 * decide what the decider is sent), and per candidate its release id, distance
 * and AcoustID coverage (both to 4 decimals) and every field of its evidence.
 * A nullable key that is missing counts as null; a number that is not finite
 * throws. Nothing else: no candidate row id, no timestamps, no property outside these
 * types, and object key order and candidate order do not matter.
 */
export function evidenceHash(album: AlbumEvidence, candidates: EvidenceCandidate[]): string {
  // Sorted by release id, then by the entry's own text, so two entries for
  // the same release (two providers' copies) hash the same in any order.
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = candidates
    .map((c) => {
      const entry = {
        r: c.releaseId, d: round4(finite(c.distance, 'candidate distance')),
        a: round4OrNull(finiteOrNull(c.acoustidCoverage, 'AcoustID coverage')),
        e: c.evidence === null || c.evidence === undefined ? null : candidateEvidenceHashView(c.evidence),
      };
      return { entry, text: stableJson(entry) };
    })
    .sort((x, y) => cmp(x.entry.r, y.entry.r) || cmp(x.text, y.text))
    .map((x) => x.entry);
  return createHash('sha256').update(stableJson({ album: albumHashView(album), candidates: sorted })).digest('hex');
}

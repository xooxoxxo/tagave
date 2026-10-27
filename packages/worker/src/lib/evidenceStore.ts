/**
 * Matching evidence in the database: the album's side (album_evidence) and
 * each candidate's (match_candidates.evidence), and the hash a decision is
 * pinned to. Only what may leave the server is loaded: no excluded
 * candidates and no linked-app suggestions (mc:<link>).
 */
import type postgres from 'postgres';
import {
  evidenceHash, mediumCountOf,
  type AlbumEvidence, type CandidateEvidence, type CanonicalRelease, type EvidenceCandidate, type RemoteInput,
} from '@tagave/core';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** the request-side view of one album's evidence (sendable candidates only) */
export interface LoadedEvidence {
  albumId: string;
  libraryId: string;
  state: string;
  lastIdentifyAt: string | null;
  album: AlbumEvidence;
  candidates: Array<EvidenceCandidate & { candidateId: string; source: string; provider: 'musicbrainz' | 'discogs'; status: string | null }>;
}

export async function upsertAlbumEvidence(sql: Sql, albumId: string, ev: AlbumEvidence): Promise<void> {
  await sql`insert into album_evidence (local_album_id, v, evidence, updated_at)
            values (${albumId}, ${ev.v}, ${JSON.stringify(ev)}::text::jsonb, now())
            on conflict (local_album_id) do update set v = excluded.v, evidence = excluded.evidence, updated_at = now()`;
}

/** The shared client hands timestamptz back as text; another client may give a Date. */
function isoOrNull(t: Date | string | null): string | null {
  if (t === null) return null;
  return (t instanceof Date ? t : new Date(t)).toISOString();
}

export async function loadEvidence(sql: Sql, albumId: string): Promise<LoadedEvidence | null> {
  const [a] = await sql<Array<{ library_id: string; state: string; last_identify_at: Date | string | null; evidence: AlbumEvidence }>>`
    select la.library_id, la.state, la.last_identify_at, ae.evidence
      from local_albums la join album_evidence ae on ae.local_album_id = la.id where la.id = ${albumId}`;
  if (!a) return null;
  const rows = await sql<Array<{ id: string; release_id: string; distance: string; acoustid_coverage: string | null; evidence: CandidateEvidence; source: string; source_of_truth: string | null; status: string | null }>>`
    select mc.id, mc.release_id, mc.distance::text as distance, mc.acoustid_coverage::text as acoustid_coverage,
           mc.evidence, mc.source, r.source_of_truth, r.status
      from match_candidates mc join releases r on r.id = mc.release_id
     where mc.local_album_id = ${albumId} and mc.excluded is not true and mc.source not like 'mc:%' and mc.evidence is not null
     order by mc.distance, mc.release_id`;
  return {
    albumId,
    libraryId: a.library_id,
    state: a.state,
    lastIdentifyAt: isoOrNull(a.last_identify_at),
    album: a.evidence,
    candidates: rows.map((r) => ({
      candidateId: r.id,
      releaseId: r.release_id,
      distance: Number(r.distance),
      acoustidCoverage: r.acoustid_coverage === null ? null : Number(r.acoustid_coverage),
      evidence: r.evidence,
      source: r.source,
      provider: r.source_of_truth === 'discogs' ? 'discogs' : 'musicbrainz',
      status: r.status,
    })),
  };
}

export async function currentEvidenceHash(sql: Sql, albumId: string): Promise<string | null> {
  const ev = await loadEvidence(sql, albumId);
  return ev ? evidenceHash(ev.album, ev.candidates) : null;
}

/**
 * A fetched or stored release as the evidence builder reads it. Durations go
 * from milliseconds to seconds; label and catalog number fall back to the
 * first entry of the release's label list; `status` is the stored release's
 * status, used when the provider shape carries none.
 */
export function remoteInputOf(r: CanonicalRelease, status: string | null): RemoteInput {
  const first = r.labels?.[0];
  const label = r.label ?? first?.name;
  const catalogNumber = r.catalogNumber ?? first?.catalogNumber;
  const mediumCount = mediumCountOf(r);
  return {
    source: r.source,
    title: r.title,
    artists: r.artists,
    ...(r.year ? { year: r.year } : {}),
    ...(r.country ? { country: r.country } : {}),
    ...(r.barcode ? { barcode: r.barcode } : {}),
    ...(label ? { label } : {}),
    ...(catalogNumber ? { catalogNumber } : {}),
    ...(r.media ? { media: r.media } : {}),
    status: r.status ?? status,
    ...(mediumCount !== undefined ? { mediumCount } : {}),
    tracks: (r.tracks ?? []).map((t) => ({
      title: t.title,
      duration: (t.duration ?? 0) / 1000,
      ...(t.mediumNumber ? { medium: t.mediumNumber } : {}),
    })),
  };
}

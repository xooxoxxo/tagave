/**
 * Matching evidence in the database: the album's side (album_evidence) and
 * each candidate's (match_candidates.evidence). Only what may leave the
 * server is loaded: no excluded candidates and no linked-app suggestions
 * (mc:<link>). Shared by the worker (identify, runs, accepts) and the api
 * (the payload preview).
 *
 * This package depends on no other tagave package, so the stored jsonb is
 * typed structurally here; callers name @tagave/core's evidence types as
 * the type arguments, which must fit these shapes. The hash a decision is
 * pinned to is made from what this loads by @tagave/core (hashOf).
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** What this package reads of album evidence (core's AlbumEvidence fits it). */
export interface StoredAlbumEvidence { v: number; title: string; titleSource: string | null; discsKnown: boolean }
/** What this package reads of candidate evidence (core's CandidateEvidence fits it). */
export interface StoredCandidateEvidence { v: number }

/** the request-side view of one album's evidence (sendable candidates only) */
export interface LoadedEvidence<A extends StoredAlbumEvidence = StoredAlbumEvidence, E extends StoredCandidateEvidence = StoredCandidateEvidence> {
  albumId: string;
  libraryId: string;
  state: string;
  lastIdentifyAt: string | null;
  album: A;
  candidates: Array<{
    candidateId: string; releaseId: string; distance: number; acoustidCoverage: number | null; evidence: E;
    source: string; provider: 'musicbrainz' | 'discogs'; status: string | null;
    /** the matcher's breakdown as stored (the local decider's features); not part of the evidence hash */
    breakdown: unknown;
  }>;
  /** a candidate that may be sent has no evidence yet: it is not in `candidates`, and the set is partial */
  partial: boolean;
}

export async function upsertAlbumEvidence(sql: Sql, albumId: string, ev: { v: number }): Promise<void> {
  await sql`insert into album_evidence (local_album_id, v, evidence, updated_at)
            values (${albumId}, ${ev.v}, ${JSON.stringify(ev)}::text::jsonb, now())
            on conflict (local_album_id) do update set v = excluded.v, evidence = excluded.evidence, updated_at = now()`;
}

/** The shared client hands timestamptz back as text; another client may give a Date. */
function isoOrNull(t: Date | string | null): string | null {
  if (t === null) return null;
  return (t instanceof Date ? t : new Date(t)).toISOString();
}

export async function loadEvidence<A extends StoredAlbumEvidence = StoredAlbumEvidence, E extends StoredCandidateEvidence = StoredCandidateEvidence>(
  sql: Sql, albumId: string,
): Promise<LoadedEvidence<A, E> | null> {
  return (await loadEvidenceMany<A, E>(sql, [albumId])).get(albumId) ?? null;
}

/**
 * loadEvidence for many albums with two set-based reads. An album without
 * album evidence (or not stored) has no entry.
 */
export async function loadEvidenceMany<A extends StoredAlbumEvidence = StoredAlbumEvidence, E extends StoredCandidateEvidence = StoredCandidateEvidence>(
  sql: Sql, albumIds: string[],
): Promise<Map<string, LoadedEvidence<A, E>>> {
  const out = new Map<string, LoadedEvidence<A, E>>();
  if (albumIds.length === 0) return out;
  const albums = await sql<Array<{ id: string; library_id: string; state: string; last_identify_at: Date | string | null; evidence: A }>>`
    select la.id, la.library_id, la.state, la.last_identify_at, ae.evidence
      from local_albums la join album_evidence ae on ae.local_album_id = la.id where la.id = any(${albumIds}::uuid[])`;
  if (albums.length === 0) return out;
  const rows = await sql<Array<{ id: string; local_album_id: string; release_id: string; distance: string; acoustid_coverage: string | null; evidence: E | null; source: string; source_of_truth: string | null; status: string | null; breakdown: unknown }>>`
    select mc.id, mc.local_album_id, mc.release_id, mc.distance::text as distance, mc.acoustid_coverage::text as acoustid_coverage,
           mc.evidence, mc.source, r.source_of_truth, r.status, mc.breakdown
      from match_candidates mc join releases r on r.id = mc.release_id
     where mc.local_album_id = any(${albums.map((a) => a.id)}::uuid[])
       and mc.excluded is not true and mc.source not like 'mc:%'
     order by mc.local_album_id, mc.distance, mc.release_id`;
  for (const a of albums) {
    out.set(a.id, {
      albumId: a.id, libraryId: a.library_id, state: a.state, lastIdentifyAt: isoOrNull(a.last_identify_at), album: a.evidence, candidates: [], partial: false,
    });
  }
  for (const r of rows) {
    const ev = out.get(r.local_album_id);
    if (!ev) continue;
    if (r.evidence === null) { ev.partial = true; continue; }
    ev.candidates.push({
      candidateId: r.id,
      releaseId: r.release_id,
      distance: Number(r.distance),
      acoustidCoverage: r.acoustid_coverage === null ? null : Number(r.acoustid_coverage),
      evidence: r.evidence,
      source: r.source,
      provider: r.source_of_truth === 'discogs' ? 'discogs' : 'musicbrainz',
      status: r.status,
      breakdown: r.breakdown,
    });
  }
  return out;
}

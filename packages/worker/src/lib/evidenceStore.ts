/**
 * Matching evidence in the database, for the worker: the loads and the
 * album-side write live in @tagave/db (the api's payload preview reads them
 * too), named here with core's evidence types; the hash a decision is
 * pinned to is core's hashOf over what they load.
 */
import type postgres from 'postgres';
import {
  hashOf, mediumCountOf,
  type AlbumEvidence, type CandidateEvidence, type CanonicalRelease, type RemoteInput,
} from '@tagave/core';
import {
  loadEvidence as loadStored, loadEvidenceMany as loadStoredMany, upsertAlbumEvidence as upsertStored, type LoadedEvidence as StoredLoaded,
} from '@tagave/db';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** the request-side view of one album's evidence (sendable candidates only) */
export type LoadedEvidence = StoredLoaded<AlbumEvidence, CandidateEvidence>;

export async function upsertAlbumEvidence(sql: Sql, albumId: string, ev: AlbumEvidence): Promise<void> {
  await upsertStored(sql, albumId, ev);
}

export async function loadEvidence(sql: Sql, albumId: string): Promise<LoadedEvidence | null> {
  return loadStored<AlbumEvidence, CandidateEvidence>(sql, albumId);
}

/** loadEvidence for many albums; an album without album evidence has no entry. */
export async function loadEvidenceMany(sql: Sql, albumIds: string[]): Promise<Map<string, LoadedEvidence>> {
  return loadStoredMany<AlbumEvidence, CandidateEvidence>(sql, albumIds);
}

export async function currentEvidenceHash(sql: Sql, albumId: string): Promise<string | null> {
  const ev = await loadEvidence(sql, albumId);
  return ev ? hashOf(ev) : null;
}

/** currentEvidenceHash for many albums at once; null for an album with no album evidence. */
export async function currentEvidenceHashes(sql: Sql, albumIds: string[]): Promise<Map<string, string | null>> {
  const loaded = await loadEvidenceMany(sql, albumIds);
  return new Map(albumIds.map((id) => {
    const ev = loaded.get(id);
    return [id, ev ? hashOf(ev) : null];
  }));
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

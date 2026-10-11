/**
 * What the auto-accept rules decide over: the library's needs_review albums
 * with their live (not excluded) candidates, and the stored rules row.
 * Shared by the API (dry run in the rules dialog) and the worker (rules on
 * new matches, "Accept N now"), so both read exactly the same inputs.
 */
import { sql } from 'drizzle-orm';

type Db = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface RulesInputCandidate {
  id: string;
  releaseId: string;
  distance: number;
  breakdown: Record<string, unknown> | null;
  /** how the candidate was found (match_candidates.source) */
  source: string;
  /** 'musicbrainz' | 'discogs' */
  provider: string;
  status: string | null;
  title: string;
  artist: string | null;
  date: string | null;
  country: string | null;
  trackCount: number | null;
}

export interface RulesInputAlbum {
  albumId: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  /** local tracks of the album (what the matcher compared) */
  trackCount: number;
  candidates: RulesInputCandidate[];
}

function dateText(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v);
}

function artistText(v: unknown): string | null {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ') || null;
  return typeof v === 'string' && v ? v : null;
}

/** needs_review albums of a library (or just `albumIds` of them), each with its live candidates, best first. */
export async function fetchRulesInputs(db: Db, libraryId: string, albumIds?: string[]): Promise<RulesInputAlbum[]> {
  if (albumIds && albumIds.length === 0) return [];
  const only = albumIds ? sql`and la.id in (${sql.join(albumIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const albums = await db.execute(sql`
    select la.id, la.title_guess, la.artist_guess, la.year_guess,
           (select count(*)::int from local_tracks lt where lt.local_album_id = la.id) as track_count
      from local_albums la
     where la.library_id = ${libraryId} and la.state = 'needs_review' ${only}`) as Array<Record<string, unknown>>;
  if (albums.length === 0) return [];
  const cands = await db.execute(sql`
    select mc.id, mc.local_album_id, mc.release_id, mc.distance, mc.breakdown, mc.source,
           r.source_of_truth, r.status, r.title, r.date, r.country, r.track_count, rg.artist_credit
      from match_candidates mc
      join local_albums la on la.id = mc.local_album_id
      join releases r on r.id = mc.release_id
      join release_groups rg on rg.id = r.release_group_id
     where la.library_id = ${libraryId} and la.state = 'needs_review' and mc.excluded is not true ${only}
     order by mc.distance asc`) as Array<Record<string, unknown>>;

  const byAlbum = new Map<string, RulesInputCandidate[]>();
  for (const c of cands) {
    const albumId = String(c['local_album_id']);
    const list = byAlbum.get(albumId) ?? [];
    list.push({
      id: String(c['id']),
      releaseId: String(c['release_id']),
      distance: Number(c['distance']),
      breakdown: (c['breakdown'] as Record<string, unknown> | null) ?? null,
      source: String(c['source'] ?? ''),
      provider: String(c['source_of_truth'] ?? 'musicbrainz'),
      status: (c['status'] as string | null) ?? null,
      title: String(c['title'] ?? ''),
      artist: artistText(c['artist_credit']),
      date: dateText(c['date']),
      country: (c['country'] as string | null) ?? null,
      trackCount: c['track_count'] == null ? null : Number(c['track_count']),
    });
    byAlbum.set(albumId, list);
  }
  return albums.map((a) => ({
    albumId: String(a['id']),
    title: (a['title_guess'] as string | null) ?? null,
    artist: (a['artist_guess'] as string | null) ?? null,
    year: a['year_guess'] == null ? null : Number(a['year_guess']),
    trackCount: Number(a['track_count'] ?? 0),
    candidates: byAlbum.get(String(a['id'])) ?? [],
  }));
}

export interface AutoAcceptRulesRow {
  enabled: boolean;
  minMatch: number;
  allChecksAgree: boolean;
  clearWinnerGap: number;
  preferSource: string;
  officialOnly: boolean;
  updatedAt: string;
}

/** The library's stored rules, or null when the owner never saved any. */
export async function fetchAutoAcceptRulesRow(db: Db, libraryId: string): Promise<AutoAcceptRulesRow | null> {
  const rows = await db.execute(sql`
    select enabled, min_match, all_checks_agree, clear_winner_gap, prefer_source, official_only, updated_at
      from auto_accept_rules where library_id = ${libraryId}`) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const updated = r['updated_at'];
  return {
    enabled: r['enabled'] === true,
    minMatch: Number(r['min_match']),
    allChecksAgree: r['all_checks_agree'] === true,
    clearWinnerGap: Number(r['clear_winner_gap']),
    preferSource: String(r['prefer_source']),
    officialOnly: r['official_only'] === true,
    updatedAt: new Date(updated as string | Date).toISOString(),
  };
}

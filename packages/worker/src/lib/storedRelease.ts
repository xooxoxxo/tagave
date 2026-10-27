/**
 * A candidate release rebuilt from what identification stored (releases,
 * release_groups, canonical_tracks), in the provider shape the scorer reads.
 * Used to re-score without the network: the evidence backfill and the
 * barcode regression report.
 */
import type { CanonicalRelease } from '@tagave/core';
import type { WorkerContext } from './context.js';

export interface StoredRelease { dbId: string; release: CanonicalRelease; status: string | null; complete: boolean }

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function storedReleases(ctx: Pick<WorkerContext, 'sql'>, releaseIds: string[]): Promise<Map<string, StoredRelease>> {
  const out = new Map<string, StoredRelease>();
  if (releaseIds.length === 0) return out;
  const rels = await ctx.sql<Array<Record<string, any>>>`
    select r.id, r.mbid, r.discogs_release_id, r.title, r.status, r.date::text as date, r.country, r.barcode, r.labels, r.media,
           r.source_of_truth, rg.mbid as rg_mbid, rg.id as rg_id, rg.artist_credit
      from releases r join release_groups rg on rg.id = r.release_group_id
     where r.id = any(${releaseIds}::uuid[])`;
  const tracks = await ctx.sql<Array<{ release_id: string; medium_no: number; position: number | null; title: string; length_ms: number | null; recording_mbid: string | null; artist_credit: unknown }>>`
    select release_id, medium_no, position, title, length_ms, recording_mbid, artist_credit
      from canonical_tracks where release_id = any(${releaseIds}::uuid[])
     order by release_id, medium_no, position nulls last`;
  for (const r of rels) {
    const own = tracks.filter((t) => t.release_id === r['id']);
    const labels = Array.isArray(r['labels']) ? r['labels'] as Array<{ name?: unknown; catalogNumber?: unknown; catno?: unknown }> : [];
    const media = Array.isArray(r['media']) ? r['media'] as Array<{ position: number; format: string; trackCount: number }> : [];
    const credit = Array.isArray(r['artist_credit']) ? (r['artist_credit'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const discogs = r['source_of_truth'] === 'discogs';
    const year = /^(\d{4})/.exec(r['date'] ?? '')?.[1];
    const label = text(labels[0]?.name);
    const catalogNumber = text(labels[0]?.catalogNumber) ?? text(labels[0]?.catno);
    const release: CanonicalRelease = {
      id: discogs ? String(r['discogs_release_id'] ?? r['id']) : String(r['mbid'] ?? r['id']),
      releaseGroupId: String(r['rg_mbid'] ?? r['rg_id']),
      title: String(r['title']),
      artists: credit,
      tracks: own.map((t) => ({
        title: t.title,
        artists: Array.isArray(t.artist_credit) ? (t.artist_credit as unknown[]).filter((a): a is string => typeof a === 'string') : [],
        duration: t.length_ms ?? 0,
        position: t.position ?? 0,
        mediumNumber: t.medium_no,
        ...(t.recording_mbid ? { recordingId: t.recording_mbid } : {}),
      })),
      source: discogs ? 'discogs' : 'musicbrainz',
      ...(year ? { year: Number(year) } : {}),
      ...(text(r['country']) ? { country: text(r['country']) } : {}),
      ...(text(r['barcode']) ? { barcode: text(r['barcode']) } : {}),
      ...(label ? { label } : {}),
      ...(catalogNumber ? { catalogNumber } : {}),
      ...(media.length ? { mediaList: media } : {}),
    };
    out.set(String(r['id']), { dbId: String(r['id']), release, status: (r['status'] as string | null) ?? null, complete: own.length > 0 });
  }
  return out;
}

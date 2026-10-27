/**
 * A candidate release rebuilt from what identification stored (releases,
 * release_groups, canonical_tracks), in the provider shape the scorer reads.
 * Used to re-score stored candidates without the network.
 *
 * The release row keeps what the first fetch stored (a later store only
 * touches its fetch time), and release artists come from the release group;
 * tracks are current. A release with no stored tracks comes back with
 * complete: false and cannot be scored: the caller skips it or identifies
 * the album again.
 */
import type { CanonicalRelease } from '@tagave/core';
import type { WorkerContext } from './context.js';

export interface StoredRelease { dbId: string; release: CanonicalRelease; status: string | null; complete: boolean }

/** Ids per query, so a caller can pass any number of them. */
const CHUNK = 500;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function storedReleases(ctx: Pick<WorkerContext, 'sql'>, releaseIds: string[]): Promise<Map<string, StoredRelease>> {
  const out = new Map<string, StoredRelease>();
  for (let i = 0; i < releaseIds.length; i += CHUNK) {
    await storedChunk(ctx, releaseIds.slice(i, i + CHUNK), out);
  }
  return out;
}

type TrackRow = { release_id: string; medium_no: number; position: number | null; title: string; length_ms: number | null; recording_mbid: string | null; artist_credit: unknown };

async function storedChunk(ctx: Pick<WorkerContext, 'sql'>, releaseIds: string[], out: Map<string, StoredRelease>): Promise<void> {
  const rels = await ctx.sql<Array<Record<string, any>>>`
    select r.id, r.mbid, r.discogs_release_id, r.title, r.status, r.date::text as date, r.country, r.barcode, r.labels, r.media,
           r.source_of_truth, rg.mbid as rg_mbid, rg.id as rg_id, rg.artist_credit
      from releases r join release_groups rg on rg.id = r.release_group_id
     where r.id = any(${releaseIds}::uuid[])`;
  const tracks = await ctx.sql<TrackRow[]>`
    select release_id, medium_no, position, title, length_ms, recording_mbid, artist_credit
      from canonical_tracks where release_id = any(${releaseIds}::uuid[])
     order by release_id, medium_no, position nulls last`;
  const byRelease = new Map<string, TrackRow[]>();
  for (const t of tracks) {
    const list = byRelease.get(t.release_id);
    if (list) list.push(t); else byRelease.set(t.release_id, [t]);
  }
  for (const r of rels) {
    const own = byRelease.get(String(r['id'])) ?? [];
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
}

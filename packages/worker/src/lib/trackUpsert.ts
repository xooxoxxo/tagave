/**
 * local_tracks in place (move-safe scanning §2). A re-cluster used to delete
 * and re-insert every track of the files it saw: new track ids, the canonical
 * link and recording id gone, player_track_map cascaded away, while
 * tracks_linked_at stayed set so tracks.link never ran again. That happened on
 * every tag write, not only on moves.
 *
 * Rows are keyed by (audio_file_id, cue_start_ms) (0053, NULLS NOT DISTINCT).
 * Existing rows keep their id and links; only the tag-derived fields change.
 * Rows the files no longer produce are deleted. An album whose tracks changed
 * in anything the link reads (album membership, disc, track, title, artist,
 * duration, rows added or removed) gets tracks_linked_at cleared. A row that
 * moves to another album loses its old release link (Ruling 11).
 */
import type { WorkerContext } from './context.js';

export interface TrackRowInput {
  localAlbumId: string | null;
  audioFileId: string;
  discNo: number | null;
  trackNo: number | null;
  titleGuess: string | null;
  artistGuess: string | null;
  durationMs: number | null;
  origin: 'file' | 'cue';
  cueStartMs: number | null;
  cueRelPath: string | null;
}

export interface UpsertTracksResult {
  inserted: number;
  updated: number;
  deleted: number;
  relinkAlbumIds: string[];
}

interface ExistingTrack {
  id: string;
  audio_file_id: string;
  cue_start_ms: number | null;
  local_album_id: string | null;
  disc_no: number | null;
  track_no: number | null;
  title_guess: string | null;
  artist_guess: string | null;
  duration_ms: number | null;
}

const keyOf = (fileId: string, cueStartMs: number | null) => `${fileId}\n${cueStartMs ?? ''}`;

export async function upsertTracks(
  ctx: Pick<WorkerContext, 'sql'>,
  lockKey: string,
  fileIds: string[],
  rows: TrackRowInput[],
): Promise<UpsertTracksResult> {
  // One row per key: a cue sheet naming one start twice keeps its first track.
  const wanted = new Map<string, TrackRowInput>();
  for (const r of rows) {
    const k = keyOf(r.audioFileId, r.cueStartMs);
    if (!wanted.has(k)) wanted.set(k, r);
  }
  if (fileIds.length === 0) return { inserted: 0, updated: 0, deleted: 0, relinkAlbumIds: [] };

  return ctx.sql.begin(async (tx) => {
    // Sibling disc folders of one album are clustered by concurrent jobs that
    // each carry every file of the set: one unit per album.
    await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const existing = (await tx`
      select id, audio_file_id, cue_start_ms, local_album_id, disc_no, track_no, title_guess, artist_guess, duration_ms
        from local_tracks where audio_file_id = any(${fileIds}::uuid[]) for update`) as unknown as ExistingTrack[];
    const byKey = new Map(existing.map((e) => [keyOf(e.audio_file_id, e.cue_start_ms), e]));
    const relink = new Set<string>();
    const inserts: TrackRowInput[] = [];
    const updates: Array<{ id: string; r: TrackRowInput }> = [];

    for (const [k, r] of wanted) {
      const e = byKey.get(k);
      if (!e) {
        inserts.push(r);
        if (r.localAlbumId) relink.add(r.localAlbumId);
        continue;
      }
      byKey.delete(k);
      const albumChanged = e.local_album_id !== r.localAlbumId;
      const linkInputChanged = albumChanged
        || e.disc_no !== r.discNo || e.track_no !== r.trackNo
        || e.title_guess !== r.titleGuess || e.artist_guess !== r.artistGuess
        || e.duration_ms !== r.durationMs;
      if (linkInputChanged) {
        if (e.local_album_id) relink.add(e.local_album_id);
        if (r.localAlbumId) relink.add(r.localAlbumId);
      }
      updates.push({ id: e.id, r });
    }
    const gone = [...byKey.values()];
    for (const g of gone) if (g.local_album_id) relink.add(g.local_album_id);

    if (gone.length > 0) await tx`delete from local_tracks where id = any(${gone.map((g) => g.id)}::uuid[])`;

    if (updates.length > 0) {
      await tx`
        update local_tracks lt set
          local_album_id = u.album, disc_no = u.disc, track_no = u.track, title_guess = u.title,
          artist_guess = u.artist, duration_ms = u.dur, origin = u.origin, cue_rel_path = u.cue_rel,
          canonical_track_id = case when lt.local_album_id is distinct from u.album then null else lt.canonical_track_id end,
          recording_id       = case when lt.local_album_id is distinct from u.album then null else lt.recording_id end,
          match_distance     = case when lt.local_album_id is distinct from u.album then null else lt.match_distance end,
          state              = case when lt.local_album_id is distinct from u.album then 'unmatched' else lt.state end
        from unnest(
          ${updates.map((u) => u.id)}::uuid[], ${updates.map((u) => u.r.localAlbumId)}::uuid[],
          ${updates.map((u) => u.r.discNo)}::int[], ${updates.map((u) => u.r.trackNo)}::int[],
          ${updates.map((u) => u.r.titleGuess)}::text[], ${updates.map((u) => u.r.artistGuess)}::text[],
          ${updates.map((u) => u.r.durationMs)}::int[], ${updates.map((u) => u.r.origin)}::text[],
          ${updates.map((u) => u.r.cueRelPath)}::text[]
        ) as u(id, album, disc, track, title, artist, dur, origin, cue_rel)
        where lt.id = u.id`;
    }

    if (inserts.length > 0) {
      await tx`
        insert into local_tracks (local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess,
                                  duration_ms, state, origin, cue_start_ms, cue_rel_path)
        select u.album, u.file, u.disc, u.track, u.title, u.artist, u.dur, 'unmatched', u.origin, u.cue_start, u.cue_rel
          from unnest(
            ${inserts.map((r) => r.localAlbumId)}::uuid[], ${inserts.map((r) => r.audioFileId)}::uuid[],
            ${inserts.map((r) => r.discNo)}::int[], ${inserts.map((r) => r.trackNo)}::int[],
            ${inserts.map((r) => r.titleGuess)}::text[], ${inserts.map((r) => r.artistGuess)}::text[],
            ${inserts.map((r) => r.durationMs)}::int[], ${inserts.map((r) => r.origin)}::text[],
            ${inserts.map((r) => r.cueStartMs)}::int[], ${inserts.map((r) => r.cueRelPath)}::text[]
          ) as u(album, file, disc, track, title, artist, dur, origin, cue_start, cue_rel)
        on conflict (audio_file_id, cue_start_ms) do nothing`;
    }

    const relinkAlbumIds = [...relink];
    if (relinkAlbumIds.length > 0) {
      await tx`update local_albums set tracks_linked_at = null
               where id = any(${relinkAlbumIds}::uuid[]) and tracks_linked_at is not null`;
    }
    return { inserted: inserts.length, updated: updates.length, deleted: gone.length, relinkAlbumIds };
  });
}

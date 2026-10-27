/**
 * Tracks as the queue plays them, from any albums (Play next, Add to queue,
 * a playlist), and the person's queue on the server (player_queue_state,
 * 0055). Each album's tracks come from albumQueue (lib/player.ts), so a
 * track's availability and matching are the same as when its album plays.
 */
import type postgres from 'postgres';
import type { PgBoss } from 'pg-boss';
import type { QueueContext, QueueOrigin, QueueStateInput, QueueStateView, QueueTrack } from '@tagave/shared';
import { albumById, albumQueue, backendFor, libraryById } from './player.js';

type Sql = postgres.Sql<any>;

export class PlayerNotInstalled extends Error {}

/** The tracks with these ids, in the order asked; ids not in the library are left out. */
export async function queueTracks(deps: { sql: Sql; boss: Pick<PgBoss, 'send'> | null; fetchImpl?: typeof fetch }, ids: readonly string[]): Promise<QueueTrack[]> {
  if (ids.length === 0) return [];
  const rows = await deps.sql<Array<{ id: string; album: string }>>`
    select lt.id::text as id, lt.local_album_id::text as album from local_tracks lt where lt.id = any(${[...new Set(ids)]}::uuid[]) and lt.local_album_id is not null`;
  const albumOf = new Map(rows.map((r) => [r.id, r.album]));
  const albums = [...new Set(rows.map((r) => r.album))];
  const byId = new Map<string, QueueTrack>();
  for (const albumId of albums) {
    const album = await albumById(deps.sql, albumId);
    if (!album) continue;
    const lib = await libraryById(deps.sql, album.library_id);
    const backend = backendFor(lib?.settings);
    if (!backend) throw new PlayerNotInstalled();
    const view = await albumQueue(deps, backend, album);
    for (const t of view.tracks) {
      byId.set(t.localTrackId, { ...t, albumId: view.albumId, coverUrl: view.coverUrl, artists: view.artists ?? [], year: view.year ?? null });
    }
  }
  return ids.filter((id) => albumOf.has(id) && byId.has(id)).map((id) => byId.get(id)!);
}

interface StateRow {
  items: Array<{ id: string; origin: QueueOrigin }>;
  context: QueueContext | null;
  idx: number;
  position_ms: number;
  device_id: string;
  revision: number | string;
  updated_at: Date;
}

const EMPTY: QueueStateView = { items: [], context: null, index: -1, positionMs: 0, deviceId: null, revision: 0, updatedAt: null };

/** The person's queue with each track resolved; a track gone from the library drops out (the index follows). */
export async function readQueue(deps: { sql: Sql; boss: Pick<PgBoss, 'send'> | null }, userId: string): Promise<QueueStateView> {
  const [row] = await deps.sql<StateRow[]>`select items, context, idx, position_ms, device_id, revision, updated_at from player_queue_state where user_id = ${userId}`;
  if (!row) return EMPTY;
  const items = Array.isArray(row.items) ? row.items : [];
  const tracks = new Map((await queueTracks(deps, items.map((i) => i.id))).map((t) => [t.localTrackId, t]));
  const out: QueueStateView['items'] = [];
  let index = -1;
  items.forEach((it, i) => {
    const t = tracks.get(it.id);
    if (!t) return;
    if (i === row.idx) index = out.length;
    out.push({ ...t, origin: it.origin });
  });
  // the playing track left the library: the next one still there takes its place, at its start
  let positionMs = row.position_ms;
  if (index < 0 && row.idx >= 0) {
    index = Math.min(out.length - 1, items.slice(0, row.idx).filter((it) => tracks.has(it.id)).length);
    positionMs = 0;
  }
  return { items: out, context: row.context, index, positionMs, deviceId: row.device_id, revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString() };
}

export type WriteOutcome =
  | { ok: true; updatedAt: string; revision: number }
  | { ok: false; reason: 'taken' | 'stale' };

/**
 * Writes the queue. play: this device plays from now on. save: only the
 * device that plays, from the latest revision. edit: any device, from the
 * latest revision; the device that plays and its place are kept.
 */
export async function writeQueue(sql: Sql, userId: string, s: QueueStateInput): Promise<WriteOutcome> {
  const index = s.items.length === 0 ? -1 : Math.min(s.index, s.items.length - 1);
  const mode = s.mode ?? 'save';
  const base = s.revision ?? null;
  const rows = await sql<Array<{ updated_at: Date; revision: number | string }>>`
    insert into player_queue_state (user_id, items, context, idx, position_ms, device_id, revision, updated_at)
    values (${userId}, ${JSON.stringify(s.items)}::text::jsonb, ${s.context ? JSON.stringify(s.context) : null}::text::jsonb, ${index}, ${s.positionMs}, ${s.deviceId}, 1, clock_timestamp())
    on conflict (user_id) do update set items = excluded.items, context = excluded.context, idx = excluded.idx,
      position_ms = case when ${mode} = 'edit' then player_queue_state.position_ms else excluded.position_ms end,
      device_id = case when ${mode} = 'edit' then player_queue_state.device_id else excluded.device_id end,
      revision = player_queue_state.revision + 1,
      updated_at = excluded.updated_at
      where ${mode} = 'play'
         or (${mode} = 'save' and player_queue_state.device_id = excluded.device_id and player_queue_state.revision = coalesce(${base}::bigint, player_queue_state.revision))
         or (${mode} = 'edit' and player_queue_state.revision = coalesce(${base}::bigint, player_queue_state.revision))
    returning updated_at, revision`;
  if (rows[0]) return { ok: true, updatedAt: new Date(rows[0].updated_at).toISOString(), revision: Number(rows[0].revision) };
  const [now] = await sql<Array<{ device_id: string }>>`select device_id from player_queue_state where user_id = ${userId}`;
  return { ok: false, reason: mode === 'save' && now && now.device_id !== s.deviceId ? 'taken' : 'stale' };
}

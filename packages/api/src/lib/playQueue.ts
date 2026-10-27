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
  updated_at: Date;
}

const EMPTY: QueueStateView = { items: [], context: null, index: -1, positionMs: 0, deviceId: null, updatedAt: null };

/** The person's queue with each track resolved; a track gone from the library drops out (the index follows). */
export async function readQueue(deps: { sql: Sql; boss: Pick<PgBoss, 'send'> | null }, userId: string): Promise<QueueStateView> {
  const [row] = await deps.sql<StateRow[]>`select items, context, idx, position_ms, device_id, updated_at from player_queue_state where user_id = ${userId}`;
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
  return { items: out, context: row.context, index, positionMs, deviceId: row.device_id, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function writeQueue(sql: Sql, userId: string, s: QueueStateInput): Promise<{ updatedAt: string }> {
  const index = s.items.length === 0 ? -1 : Math.min(s.index, s.items.length - 1);
  const [row] = await sql<Array<{ updated_at: Date }>>`
    insert into player_queue_state (user_id, items, context, idx, position_ms, device_id, updated_at)
    values (${userId}, ${JSON.stringify(s.items)}::text::jsonb, ${s.context ? JSON.stringify(s.context) : null}::text::jsonb, ${index}, ${s.positionMs}, ${s.deviceId}, clock_timestamp())
    on conflict (user_id) do update set items = excluded.items, context = excluded.context, idx = excluded.idx,
      position_ms = excluded.position_ms, device_id = excluded.device_id, updated_at = excluded.updated_at
    returning updated_at`;
  return { updatedAt: new Date(row!.updated_at).toISOString() };
}

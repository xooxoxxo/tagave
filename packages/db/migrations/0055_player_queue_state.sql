-- The play queue, per person, on the server (the player module): what is
-- playing, what comes next and where it stopped, so the queue follows the
-- person from one device to another. device_id is the device that plays:
-- only a play action on another device takes it over (that one pauses).
-- Any device may change the queue (Play next, reorder, ...) without taking
-- playback; revision, bumped on every write, keeps a write made from an
-- older copy from undoing a newer one. History is not kept here: it is
-- player_plays.
--
-- items: [{ "id": "<local_tracks.id>", "origin": "queued" | "context" }],
-- in play order. "queued" are the tracks the person added with Play next or
-- Add to queue; "context" the album or playlist they started.
-- context: { "kind": "album" | "playlist", "id": "...", "name": "..." }.
--
-- The player module's own table (Module Composition Principle rule 1): keyed
-- to users with ON DELETE CASCADE, no core table references it, and the
-- player's "Delete its data" (doctor › modulePurge.ts) empties it.
create table if not exists player_queue_state (
  user_id uuid primary key references users(id) on delete cascade,
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  context jsonb,
  idx integer not null default -1,
  position_ms integer not null default 0 check (position_ms >= 0),
  device_id text not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

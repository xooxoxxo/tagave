-- Collaborative playlists (the playlists module, 0056): the owner of a list
-- lets other people of the same install add to it, reorder it and take out
-- what they added. Still the module's own tables; no core table references
-- them, and "Delete its data" (doctor › purge-module playlists) empties this
-- one with the other two.
--
--   playlist_collaborators   who may change a list besides its owner
--   playlist_items.added_by  who put the item there (set null when that
--                            account is deleted); the rows already there
--                            were the owner's
--
-- Positions: every item of a list has its own. Renumbered once here (in the
-- order they show), then unique per list, checked at commit so a reorder can
-- move every row in one statement. Two people adding at once are taken in
-- turn (the list's row is locked, api › lib/playlists.ts).
create table if not exists playlist_collaborators (
  playlist_id uuid not null references playlists(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (playlist_id, user_id)
);
create index if not exists idx_playlist_collaborators_user on playlist_collaborators (user_id);

alter table playlist_items add column if not exists added_by uuid references users(id) on delete set null;
update playlist_items i set added_by = p.user_id from playlists p where p.id = i.playlist_id and i.added_by is null;

with ordered as (
  select id, (row_number() over (partition by playlist_id order by position, added_at, id) - 1)::int as pos from playlist_items
)
update playlist_items i set position = o.pos from ordered o where o.id = i.id and i.position is distinct from o.pos;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'playlist_items_position_unique') then
    alter table playlist_items add constraint playlist_items_position_unique unique (playlist_id, position) deferrable initially deferred;
  end if;
end
$$;

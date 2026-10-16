-- Music Connections, phases 2-3: the change log the /mc/v1 feeds page
-- through (routes/mcFeeds.ts). A row per (capability, key, library, person)
-- each time a statement changed that key; the log is append-only (no row is
-- ever updated or locked by a writer). The feed builds each item's data from
-- the current rows when it is read, and the op it serves (upsert when the key
-- has data then, else delete) is decided then too: the op stored here is only
-- the writer's view, which a concurrent writer can make stale. mc.purge drops
-- rows a newer row of the same key supersedes, and delete rows after 90 days.
--
-- Who a row belongs to: ratings and listens are one person's (user_id set);
-- collection and identity describe the library, which every account reads
-- (0043), so their rows carry user_id null.
--
-- Keys: the release group id; listens add the UTC day
-- (<release_group_id>:YYYY-MM-DD); a Discogs copy not mapped to a release
-- group is keyed by its Discogs release (discogs-release:<id>), or by the
-- copy itself when Discogs gave no release id (collection-item:<id>).
create table if not exists mc_changes (
  id bigint generated always as identity primary key,
  capability text not null check (capability in ('ratings', 'collection', 'listens', 'identity')),
  key text not null,
  op text not null check (op in ('upsert', 'delete')),
  user_id uuid references users(id) on delete cascade,
  library_id uuid not null references libraries(id) on delete cascade,
  changed_at timestamptz not null default clock_timestamp()
);
-- The feed: one capability, one person (or the library's null), in order.
create index if not exists idx_mc_changes_feed on mc_changes (capability, user_id, changed_at, id);
-- Superseded rows (mc.purge) and the audio_files trigger's once-per-statement check.
create index if not exists idx_mc_changes_key on mc_changes (capability, key, changed_at, id);
-- mc.purge: tombstones by age.
create index if not exists idx_mc_changes_tombstones on mc_changes (changed_at) where op = 'delete';

-- ── Keys and presence ──────────────────────────────────────────────────────

create or replace function mc_collection_key(rg uuid, discogs_release integer, item uuid) returns text
language sql immutable as $$
  select coalesce(rg::text, 'discogs-release:' || discogs_release::text, 'collection-item:' || item::text)
$$;

create or replace function mc_listen_key(rg uuid, at timestamptz) returns text
language sql stable as $$
  select rg::text || ':' || to_char(at at time zone 'UTC', 'YYYY-MM-DD')
$$;

-- Whether a key has data in the writer's snapshot (upsert) or not (delete).
-- Only a hint: the feed decides the op when it reads.
create or replace function mc_present(cap text, lib uuid, usr uuid, k text) returns boolean
language plpgsql stable as $$
declare
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  rg uuid;
  day date;
begin
  if cap = 'ratings' then
    if k !~ uuid_re then return false; end if;
    return exists (select 1 from user_reviews r
                    where r.library_id = lib and r.user_id = usr and r.release_group_id = k::uuid and r.rating is not null);
  elsif cap = 'listens' then
    if split_part(k, ':', 1) !~ uuid_re or split_part(k, ':', 2) !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
    rg := split_part(k, ':', 1)::uuid;
    day := split_part(k, ':', 2)::date;
    return exists (select 1 from listens l
                    where l.library_id = lib and l.user_id = usr and l.release_group_id = rg
                      and l.listened_at >= (day::timestamp at time zone 'UTC')
                      and l.listened_at < ((day + 1)::timestamp at time zone 'UTC'));
  elsif cap = 'identity' then
    if k !~ uuid_re then return false; end if;
    return exists (select 1 from local_albums la
                    where la.library_id = lib and la.state = 'matched' and la.release_group_id = k::uuid);
  elsif cap = 'collection' then
    if k ~ uuid_re then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id = k::uuid)
          or exists (select 1 from local_albums la
                      where la.library_id = lib and la.state = 'matched' and la.release_group_id = k::uuid
                        and exists (select 1 from local_tracks lt join audio_files af on af.id = lt.audio_file_id
                                     where lt.local_album_id = la.id and af.status not in ('missing', 'archived')));
    elsif k ~ '^discogs-release:\d{1,10}$' then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id is null
                        and ci.discogs_release_id = substr(k, 17)::bigint);
    elsif k ~ ('^collection-item:' || substr(uuid_re, 2)) then
      return exists (select 1 from collection_items ci
                      where ci.library_id = lib and ci.removed_at is null and ci.release_group_id is null
                        and ci.discogs_release_id is null and ci.id = substr(k, 17)::uuid);
    end if;
    return false;
  end if;
  return false;
end $$;

-- Log the keys one statement touched: one row per (key, library, person).
-- Append-only on purpose: removing a key's older rows here would row-lock
-- them, so two writers touching one album (a rating save and a sync) would
-- wait on each other, and multi-key statements could deadlock.
-- libs, usrs and keys are parallel arrays; a null key or library is skipped.
create or replace function mc_log(cap text, libs uuid[], usrs uuid[], keys text[]) returns void
language plpgsql as $$
begin
  if keys is null or cardinality(keys) = 0 then return; end if;
  with x as materialized (
    select distinct t.l, t.u, t.k from unnest(libs, usrs, keys) as t(l, u, k)
     where t.k is not null and t.l is not null
       -- a cascade from deleting the library or the person: nothing to log
       -- (their rows go with them), and the foreign keys would refuse it
       and exists (select 1 from libraries lib where lib.id = t.l)
       and (t.u is null or exists (select 1 from users usr where usr.id = t.u))
  )
  insert into mc_changes (capability, key, op, user_id, library_id)
  select cap, x.k, case when mc_present(cap, x.l, x.u, x.k) then 'upsert' else 'delete' end, x.u, x.l
    from x order by x.k;
end $$;

-- ── Triggers ───────────────────────────────────────────────────────────────
-- Statement-level with transition tables: one mc_log call per statement and
-- capability, whatever the row count. An update logs only rows whose
-- feed-visible columns changed (both the old key and the new one), so the
-- scans and syncs that rewrite rows unchanged log nothing.

-- user_reviews → ratings. Only the rating counts: the review's text never
-- leaves tagave, so editing it is no change to the feed.
create or replace function mc_trg_user_reviews() returns trigger language plpgsql as $$
declare l uuid[]; u uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(library_id), array_agg(user_id), array_agg(release_group_id::text) into l, u, k
      from new_rows where rating is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(library_id), array_agg(user_id), array_agg(release_group_id::text) into l, u, k
      from old_rows;
  else
    select array_agg(c.l), array_agg(c.u), array_agg(c.k) into l, u, k from (
      select n.library_id as l, n.user_id as u, n.release_group_id::text as k, o.library_id as ol, o.user_id as ou, o.release_group_id::text as ok
        from new_rows n join old_rows o on o.id = n.id
       where (n.rating, n.release_group_id, n.user_id, n.library_id) is distinct from (o.rating, o.release_group_id, o.user_id, o.library_id)
    ) d cross join lateral (values (d.l, d.u, d.k), (d.ol, d.ou, d.ok)) as c(l, u, k);
  end if;
  perform mc_log('ratings', l, u, k);
  return null;
end $$;

drop trigger if exists mc_user_reviews_ins on user_reviews;
create trigger mc_user_reviews_ins after insert on user_reviews referencing new table as new_rows
  for each statement execute function mc_trg_user_reviews();
drop trigger if exists mc_user_reviews_upd on user_reviews;
create trigger mc_user_reviews_upd after update on user_reviews referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_user_reviews();
drop trigger if exists mc_user_reviews_del on user_reviews;
create trigger mc_user_reviews_del after delete on user_reviews referencing old table as old_rows
  for each statement execute function mc_trg_user_reviews();

-- listens → listens (the day's count for the album).
create or replace function mc_trg_listens() returns trigger language plpgsql as $$
declare l uuid[]; u uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(library_id), array_agg(user_id), array_agg(mc_listen_key(release_group_id, listened_at)) into l, u, k
      from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(library_id), array_agg(user_id), array_agg(mc_listen_key(release_group_id, listened_at)) into l, u, k
      from old_rows;
  else
    select array_agg(c.l), array_agg(c.u), array_agg(c.k) into l, u, k from (
      select n.library_id as l, n.user_id as u, mc_listen_key(n.release_group_id, n.listened_at) as k,
             o.library_id as ol, o.user_id as ou, mc_listen_key(o.release_group_id, o.listened_at) as ok
        from new_rows n join old_rows o on o.id = n.id
       where (n.release_group_id, n.listened_at, n.format, n.user_id, n.library_id)
             is distinct from (o.release_group_id, o.listened_at, o.format, o.user_id, o.library_id)
    ) d cross join lateral (values (d.l, d.u, d.k), (d.ol, d.ou, d.ok)) as c(l, u, k);
  end if;
  perform mc_log('listens', l, u, k);
  return null;
end $$;

drop trigger if exists mc_listens_ins on listens;
create trigger mc_listens_ins after insert on listens referencing new table as new_rows
  for each statement execute function mc_trg_listens();
drop trigger if exists mc_listens_upd on listens;
create trigger mc_listens_upd after update on listens referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_listens();
drop trigger if exists mc_listens_del on listens;
create trigger mc_listens_del after delete on listens referencing old table as old_rows
  for each statement execute function mc_trg_listens();

-- collection_items → collection. removed_at set (Discogs no longer has the
-- copy) is a change like any other: the key's op becomes delete when no copy
-- or file is left. collection.sync rewrites every copy on each run; unchanged
-- values log nothing.
create or replace function mc_trg_collection_items() returns trigger language plpgsql as $$
declare l uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(library_id), array_agg(mc_collection_key(release_group_id, discogs_release_id, id)) into l, k
      from new_rows where removed_at is null;
  elsif tg_op = 'DELETE' then
    select array_agg(library_id), array_agg(mc_collection_key(release_group_id, discogs_release_id, id)) into l, k
      from old_rows;
  else
    select array_agg(c.l), array_agg(c.k) into l, k from (
      select n.library_id as l, mc_collection_key(n.release_group_id, n.discogs_release_id, n.id) as k,
             o.library_id as ol, mc_collection_key(o.release_group_id, o.discogs_release_id, o.id) as ok
        from new_rows n join old_rows o on o.id = n.id
       where (n.release_group_id, n.discogs_release_id, n.discogs_master_id, n.formats, n.date_added, n.removed_at, n.basic_info, n.library_id)
             is distinct from (o.release_group_id, o.discogs_release_id, o.discogs_master_id, o.formats, o.date_added, o.removed_at, o.basic_info, o.library_id)
    ) d cross join lateral (values (d.l, d.k), (d.ol, d.ok)) as c(l, k);
  end if;
  perform mc_log('collection', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;

drop trigger if exists mc_collection_items_ins on collection_items;
create trigger mc_collection_items_ins after insert on collection_items referencing new table as new_rows
  for each statement execute function mc_trg_collection_items();
drop trigger if exists mc_collection_items_upd on collection_items;
create trigger mc_collection_items_upd after update on collection_items referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_collection_items();
drop trigger if exists mc_collection_items_del on collection_items;
create trigger mc_collection_items_del after delete on collection_items referencing old table as old_rows
  for each statement execute function mc_trg_collection_items();

-- local_albums → collection (its files) and identity (its match). Only
-- matched albums with a release group are keyed. The identify sweep and the
-- counters refresh touch many rows; only the listed columns count.
create or replace function mc_trg_local_albums() returns trigger language plpgsql as $$
declare l uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(library_id), array_agg(release_group_id::text) into l, k
      from new_rows where release_group_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(library_id), array_agg(release_group_id::text) into l, k
      from old_rows where release_group_id is not null;
  else
    select array_agg(c.l), array_agg(c.k) into l, k from (
      select n.library_id as l, n.release_group_id::text as k, o.library_id as ol, o.release_group_id::text as ok
        from new_rows n join old_rows o on o.id = n.id
       where (n.release_group_id, n.release_id, n.state, n.formats, n.embedded_mbid, n.preferred, n.title_guess, n.artist_guess, n.library_id)
             is distinct from (o.release_group_id, o.release_id, o.state, o.formats, o.embedded_mbid, o.preferred, o.title_guess, o.artist_guess, o.library_id)
    ) d cross join lateral (values (d.l, d.k), (d.ol, d.ok)) as c(l, k)
     where c.k is not null;
  end if;
  perform mc_log('collection', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  perform mc_log('identity', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;

drop trigger if exists mc_local_albums_ins on local_albums;
create trigger mc_local_albums_ins after insert on local_albums referencing new table as new_rows
  for each statement execute function mc_trg_local_albums();
drop trigger if exists mc_local_albums_upd on local_albums;
create trigger mc_local_albums_upd after update on local_albums referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_local_albums();
drop trigger if exists mc_local_albums_del on local_albums;
create trigger mc_local_albums_del after delete on local_albums referencing old table as old_rows
  for each statement execute function mc_trg_local_albums();

-- album_matches → identity (provenance, confidence, the matched release) of
-- the album's release group as local_albums has it now.
create or replace function mc_trg_album_matches() returns trigger language plpgsql as $$
declare l uuid[]; k text[];
begin
  if tg_op = 'INSERT' then
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select distinct local_album_id from new_rows) m join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select distinct local_album_id from old_rows) m join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  else
    select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
      from (select n.local_album_id from new_rows n join old_rows o on o.id = n.id
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id)
            union
            select o.local_album_id from new_rows n join old_rows o on o.id = n.id
             where (n.status, n.release_id, n.distance, n.source, n.local_album_id)
                   is distinct from (o.status, o.release_id, o.distance, o.source, o.local_album_id)) m
      join local_albums la on la.id = m.local_album_id
     where la.release_group_id is not null;
  end if;
  perform mc_log('identity', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;

drop trigger if exists mc_album_matches_ins on album_matches;
create trigger mc_album_matches_ins after insert on album_matches referencing new table as new_rows
  for each statement execute function mc_trg_album_matches();
drop trigger if exists mc_album_matches_upd on album_matches;
create trigger mc_album_matches_upd after update on album_matches referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_album_matches();
drop trigger if exists mc_album_matches_del on album_matches;
create trigger mc_album_matches_del after delete on album_matches referencing old table as old_rows
  for each statement execute function mc_trg_album_matches();

-- release_groups → every feed that names the album: its MBID, Discogs ids,
-- title or artist changed, or it is gone (local_albums.release_group_id has
-- no foreign key, so a deleted group leaves albums pointing at nothing).
-- Ratings and listens of a deleted group cascade and log themselves.
create or replace function mc_touch_release_groups(ids uuid[], gone boolean) returns void language plpgsql as $$
declare l uuid[]; u uuid[]; k text[];
begin
  if ids is null or cardinality(ids) = 0 then return; end if;
  if not gone then
    select array_agg(library_id), array_agg(user_id), array_agg(release_group_id::text) into l, u, k
      from (select distinct library_id, user_id, release_group_id from user_reviews
             where release_group_id = any(ids) and rating is not null) s;
    perform mc_log('ratings', l, u, k);
    select array_agg(library_id), array_agg(user_id), array_agg(key) into l, u, k
      from (select distinct library_id, user_id, mc_listen_key(release_group_id, listened_at) as key from listens
             where release_group_id = any(ids)) s;
    perform mc_log('listens', l, u, k);
  end if;
  select array_agg(library_id), array_agg(key) into l, k
    from (select library_id, release_group_id::text as key from collection_items
           where release_group_id = any(ids) and removed_at is null
          union
          select library_id, release_group_id::text from local_albums
           where release_group_id = any(ids) and state = 'matched') s;
  perform mc_log('collection', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  select array_agg(library_id), array_agg(key) into l, k
    from (select distinct library_id, release_group_id::text as key from local_albums
           where release_group_id = any(ids) and state = 'matched') s;
  perform mc_log('identity', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
end $$;

create or replace function mc_trg_release_groups() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform mc_touch_release_groups((select array_agg(id) from old_rows), true);
  else
    perform mc_touch_release_groups((
      select array_agg(n.id) from new_rows n join old_rows o on o.id = n.id
       where (n.mbid, n.title, n.artist_credit, n.discogs_master_id, n.discogs_release_id)
             is distinct from (o.mbid, o.title, o.artist_credit, o.discogs_master_id, o.discogs_release_id)), false);
  end if;
  return null;
end $$;

drop trigger if exists mc_release_groups_upd on release_groups;
create trigger mc_release_groups_upd after update on release_groups referencing new table as new_rows old table as old_rows
  for each statement execute function mc_trg_release_groups();
drop trigger if exists mc_release_groups_del on release_groups;
create trigger mc_release_groups_del after delete on release_groups referencing old table as old_rows
  for each statement execute function mc_trg_release_groups();

-- audio_files → collection (a file gone missing, or its codec read anew).
-- Row-level on purpose: a statement trigger with transition tables would copy
-- every row of every scan update (241k files, tags_raw and all) only to find
-- nothing changed. The WHEN clause is checked in the executor, so a scan that
-- leaves status and codec alone never calls the function; a statement that
-- does change them logs each album once: an album that already has a row
-- from at or after this statement's start is skipped. That is safe even when
-- the row is another transaction's: the feed reads no row newer than the
-- start of the oldest transaction still writing (this one), and decides the
-- op and data when it reads, so this statement's change is in what it serves.
create or replace function mc_trg_audio_files() returns trigger language plpgsql as $$
declare l uuid[]; k text[];
begin
  select array_agg(la.library_id), array_agg(la.release_group_id::text) into l, k
    from (select distinct lt.local_album_id from local_tracks lt where lt.audio_file_id = new.id) t
    join local_albums la on la.id = t.local_album_id
   where la.state = 'matched' and la.release_group_id is not null
     and not exists (select 1 from mc_changes m
                      where m.capability = 'collection' and m.key = la.release_group_id::text
                        and m.library_id = la.library_id and m.user_id is null
                        and m.changed_at >= statement_timestamp());
  perform mc_log('collection', l, array_fill(null::uuid, array[coalesce(cardinality(k), 0)]), k);
  return null;
end $$;

drop trigger if exists mc_audio_files_upd on audio_files;
create trigger mc_audio_files_upd after update of status, codec on audio_files
  for each row when (old.status is distinct from new.status or old.codec is distinct from new.codec)
  execute function mc_trg_audio_files();

-- ── Seed: every key that has data now, once ─────────────────────────────────
insert into mc_changes (capability, key, op, user_id, library_id)
select 'ratings', s.release_group_id::text, 'upsert', s.user_id, s.library_id
  from (select distinct library_id, user_id, release_group_id from user_reviews where rating is not null) s
 order by 2;

insert into mc_changes (capability, key, op, user_id, library_id)
select 'listens', s.key, 'upsert', s.user_id, s.library_id
  from (select distinct library_id, user_id, mc_listen_key(release_group_id, listened_at) as key from listens) s
 order by 2;

insert into mc_changes (capability, key, op, user_id, library_id)
select 'collection', s.key, 'upsert', null, s.library_id
  from (select library_id, mc_collection_key(release_group_id, discogs_release_id, id) as key
          from collection_items where removed_at is null
        union
        select la.library_id, la.release_group_id::text from local_albums la
         where la.state = 'matched' and la.release_group_id is not null
           and exists (select 1 from local_tracks lt join audio_files af on af.id = lt.audio_file_id
                        where lt.local_album_id = la.id and af.status not in ('missing', 'archived'))) s
 order by 2;

insert into mc_changes (capability, key, op, user_id, library_id)
select 'identity', s.key, 'upsert', null, s.library_id
  from (select distinct library_id, release_group_id::text as key from local_albums
         where state = 'matched' and release_group_id is not null) s
 order by 2;

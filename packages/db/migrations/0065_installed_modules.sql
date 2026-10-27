-- The module ledger (vault "tagave - Core Platform Architecture", phase A0,
-- step 2). One row per app and module this install has: whether it is on,
-- since when, its version, the newest migration of its own folder and its
-- own settings. It replaces the switches kept in the first library's
-- settings (settings.modules.<id>.enabled), which stop meaning anything once
-- a second library (Books) sits next to the first.
--
--   id              the manifest id (packages/core/src/facets/manifests.ts)
--   kind            app (music), in-process (code in the app image: mc,
--                   listen-links, playlists) or container (a compose profile)
--   version         the manifest version the app last recorded at boot
--   enabled         on or off; the app reads it per request and per job
--   enabled_at      when it was last turned on; null while it is off
--   schema_version  the newest migration of its own folder
--                   (migrations/modules/<id>/); null while its tables are in
--                   the core chain
--   settings        the module's own settings (keys its manifest declares)
--
-- The player is not here yet: it is switched by TAGAVE_PLAYER_URL, which
-- the updater writes, and two switches would drift.
set local lock_timeout = '20s';

create table if not exists installed_modules (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{0,31}$'),
  kind text not null default 'in-process' check (kind in ('app', 'in-process', 'container')),
  version text,
  enabled boolean not null default false,
  enabled_at timestamptz,
  schema_version text,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now(),
  check (enabled or enabled_at is null)
);

-- Music is the one app, and always on.
insert into installed_modules (id, kind, version, enabled, enabled_at)
values ('music', 'app', '1.0.0', true, now())
on conflict (id) do nothing;

-- The three switches, read as the app read them (the first library's
-- settings): Music Connections and Listen elsewhere were off unless set to
-- true, playlists on unless set to false. A database without a library yet
-- gets each module's default.
with first_library as (
  select case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end as s
    from libraries order by created_at, id limit 1
), switches as (
  select 'mc' as id, coalesce((select s->'modules'->'mc'->>'enabled' from first_library), '') = 'true' as on_
  union all
  select 'listen-links', coalesce((select s->'modules'->'listen-links'->>'enabled' from first_library), '') = 'true'
  union all
  select 'playlists', coalesce((select s->'modules'->'playlists'->>'enabled' from first_library), '') <> 'false'
)
insert into installed_modules (id, kind, version, enabled, enabled_at)
select id, 'in-process', '1.0.0', on_, case when on_ then now() end from switches
on conflict (id) do nothing;

-- The old switches move, so they do not linger as a second truth: each
-- `enabled` key goes, a module object left empty goes, and `modules` goes
-- when nothing else is in it. Other keys stay as they are. (Restoring the
-- backup taken before this migration brings them back with the old app.)
update libraries l
   set settings = case when c.mods = '{}'::jsonb then l.settings - 'modules' else jsonb_set(l.settings, '{modules}', c.mods) end
  from (
    select lib.id,
           coalesce((
             select jsonb_object_agg(e.key, e.v)
               from (
                 select m.key,
                        case when m.key in ('mc', 'listen-links', 'playlists') and jsonb_typeof(m.value) = 'object'
                             then m.value - 'enabled' else m.value end as v
                   from jsonb_each(lib.settings->'modules') m
               ) e
              where not (e.key in ('mc', 'listen-links', 'playlists') and e.v = '{}'::jsonb)
           ), '{}'::jsonb) as mods
      from libraries lib
     where jsonb_typeof(lib.settings) = 'object' and jsonb_typeof(lib.settings->'modules') = 'object'
  ) c
 where c.id = l.id;

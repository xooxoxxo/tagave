-- The migration ledger by module (vault "tagave - Core Platform
-- Architecture" §2.7, step 2): _migrations(name) becomes
-- _migrations(module, name). The core chain (this folder) records
-- module = 'core', which every existing row gets; an app or module with a
-- folder of its own (migrations/apps/<id>/, migrations/modules/<id>/)
-- records its id, so two chains may reuse a file name.
--
-- `module` keeps 'core' as its default: a reader or writer that knows only
-- `name` (an older doctor, the updater's psql) keeps working.
-- Re-runnable; a database whose ledger the runner made in this shape already
-- (a new install) changes nothing.
set local lock_timeout = '20s';

alter table _migrations add column if not exists module text not null default 'core';

do $$
declare
  pk text;
begin
  select conname into pk from pg_constraint
   where conrelid = 'public._migrations'::regclass and contype = 'p'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'public._migrations'::regclass and attname = 'name')]::int2[];
  if pk is not null then
    execute format('alter table _migrations drop constraint %I', pk);
    alter table _migrations add constraint _migrations_pkey primary key (module, name);
  end if;
end $$;

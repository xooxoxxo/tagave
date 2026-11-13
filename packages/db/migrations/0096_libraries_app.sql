-- One app per library (vault "tagave - Core Platform Architecture" §2.5,
-- owner decision 3; platform step 3, the Books spike). A library's app says
-- which file types its walk indexes (the handlers that app claims) and which
-- grouping job turns its files into items: music (cluster.dir, albums) or
-- books (books.group, works). Every existing library is music, and so is a
-- new one unless it says otherwise: a music install walks exactly as before
-- (a .pdf in a music folder stays a sidecar).
--
-- The id is a module ledger id (installed_modules.id), checked by shape only:
-- the ledger's row for an app is made by the app's boot, after migrations.
-- Constant default: a catalogue-only change on Postgres 11 and later, no
-- table rewrite. Re-runnable. Older versions ignore the column.
set local lock_timeout = '20s';

alter table libraries add column if not exists app text not null default 'music'
  constraint libraries_app_check check (app ~ '^[a-z][a-z0-9-]{0,31}$');

-- Quick scans (LIB-3/LIB-4): remember each directory's mtime so a scheduled
-- scan can skip the per-file stat in directories that have not changed
-- (adding, removing or renaming an entry bumps the directory mtime; an
-- in-place edit does not, which the weekly full scan still catches).
create table if not exists scan_dirs (
  scan_root_id uuid not null references scan_roots(id) on delete cascade,
  rel_path     text not null,              -- NFC, '' for the root itself
  mtime        bigint not null,            -- seconds
  last_seen_at timestamptz not null default now(),
  primary key (scan_root_id, rel_path)
);

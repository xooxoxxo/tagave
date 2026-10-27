-- The books app's own tables (platform step 3, the Books spike; vault
-- "tagave - Core Platform Architecture" §3.1, kept small): works, the
-- editions that are files of a books library, and authors. Its own chain
-- (migrations/apps/books/, ledger rows ('books', <file>)), applied after the
-- core chain on every install; the tables stay empty unless TAGAVE_DEV_APPS
-- names books, the owner turns it on and a books library is scanned.
--
-- Every row hangs off a core row with ON DELETE CASCADE, so the app never
-- holds a core row back and a core delete never leaves app rows behind:
--   books_works     → libraries   a work: one title by its first author, in one library
--   books_authors   → libraries   a person who wrote works there
--   books_editions  → files       one book file (epub, pdf, cbz) of a work; the file's
--                                 own metadata (files.tags_raw) is the truth, this is
--                                 its grouping plus a 300 px cover thumbnail
--   books_work_authors            a work's authors, in order
-- Removing a file removes its edition; doctor purge-module books empties the
-- four tables and removes the books libraries (their folders and files with
-- them). Nothing in core references these tables.
set local lock_timeout = '20s';

create table if not exists books_works (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  -- what groups editions into this work: normalised title and first author
  key text not null,
  title text not null,
  sort_title text not null,
  series text,
  series_index numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_works_library_key unique (library_id, key)
);

create table if not exists books_authors (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references libraries(id) on delete cascade,
  name text not null,
  -- normalised name: one row per person per library
  name_key text not null,
  constraint books_authors_library_name unique (library_id, name_key)
);

create table if not exists books_editions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  work_id uuid not null references books_works(id) on delete cascade,
  format text not null check (format in ('epub', 'pdf', 'cbz')),
  title text not null,
  isbn13 text check (isbn13 is null or isbn13 ~ '^97[89][0-9]{10}$'),
  language text,
  publisher text,
  published text,
  pages integer check (pages is null or pages > 0),
  -- files.tags_read_at of the parse this row was built from: unchanged, the cover is not read again
  parsed_at timestamptz,
  cover_thumb bytea,
  cover_sha256 bytea,
  updated_at timestamptz not null default now(),
  constraint books_editions_file unique (file_id),
  check ((cover_thumb is null) = (cover_sha256 is null))
);
-- JPEG does not compress: out of line, no pglz (as cover_thumbs, 0046)
alter table books_editions alter column cover_thumb set storage external;
create index if not exists idx_books_editions_work on books_editions (work_id);

create table if not exists books_work_authors (
  work_id uuid not null references books_works(id) on delete cascade,
  author_id uuid not null references books_authors(id) on delete cascade,
  position smallint not null,
  primary key (work_id, author_id)
);
create index if not exists idx_books_work_authors_author on books_work_authors (author_id);

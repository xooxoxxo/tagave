-- M4 reviews (spec REV-1..3): weekly external-review TTL stamp on the release
-- group + natural keys so the fetch job and the owner's PUT are idempotent
-- upserts. Tables have existed since 0000_init and are still empty.
alter table release_groups add column if not exists reviews_fetched_at timestamptz;

create unique index if not exists user_reviews_owner_rg_key
  on user_reviews (library_id, user_id, release_group_id);

create unique index if not exists user_review_revisions_key
  on user_review_revisions (user_review_id, revision);

create unique index if not exists external_reviews_natural_key
  on external_reviews (release_group_id, source, coalesce(source_id, ''));

create unique index if not exists review_links_natural_key
  on review_links (release_group_id, source, url);

create index if not exists idx_listens_rg_listened
  on listens (library_id, release_group_id, listened_at desc);

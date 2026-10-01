-- The owner said they really own this copy on top of an earlier one of the
-- same Discogs release ("Add another copy", or "I own both" on a duplicate).
-- Duplicate detection leaves such a copy alone, so only accidental twins (a
-- double click, a sync that added the same release twice) get flagged.
alter table collection_items add column if not exists extra_copy boolean not null default false;

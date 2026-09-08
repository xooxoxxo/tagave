-- Album facets (BRW-1) probe gaps.subject_id and entity_tags.entity_id once per
-- album. Neither column led an index (idx_gaps_natural starts with library_id,
-- idx_entity_tags_entity with entity_type), so every probe was a sequential
-- scan: 27k albums × 15k open gaps = 27 s for one count, run twice per request
-- (measured on prod 2026-09-08).
create index if not exists idx_gaps_subject on gaps (subject_id, state);
create index if not exists idx_entity_tags_entity_id on entity_tags (entity_id, kind);

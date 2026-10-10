-- Finished tag plans (applied, partially failed, cancelled, reverted) can be
-- archived: hidden from the Tag changes list until the owner opens the
-- Archived tab. Archiving changes nothing else; a plan that can still be
-- reverted keeps its journal.
alter table tag_plans add column if not exists archived_at timestamptz;
create index if not exists idx_tag_plans_library_archived on tag_plans (library_id, archived_at);

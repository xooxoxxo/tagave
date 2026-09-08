-- Ensure one tag_plan_item per (tag_plan_id, audio_file_id) pair for upserting in tagsPreview
-- This prevents duplicate items when preview is called multiple times on the same plan
CREATE UNIQUE INDEX idx_tag_plan_items_plan_file_unique
  ON tag_plan_items (tag_plan_id, audio_file_id)
  WHERE status != 'failed'; -- failed items don't block new attempts

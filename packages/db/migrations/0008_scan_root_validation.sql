-- Add scan root validation columns (spec LIB-1)
-- validation_status: 'pending' (default), 'ok', 'missing', 'not_directory', 'unreadable'
-- validation_message: error details if validation failed or mount is read-only
-- validated_at: timestamp of last validation probe
-- probe_writable: observed write ability on the worker host (may differ from intent)

alter table scan_roots
  add column validation_status varchar(20) not null default 'pending' check (validation_status in ('pending','ok','missing','not_directory','unreadable')),
  add column validation_message text,
  add column validated_at timestamptz,
  add column probe_writable boolean;

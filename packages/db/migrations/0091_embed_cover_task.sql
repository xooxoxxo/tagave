alter table maintenance_tasks drop constraint maintenance_tasks_kind_check;
alter table maintenance_tasks add constraint maintenance_tasks_kind_check
  check (kind in ('cover', 'embed-cover', 'split', 'empty-trash', 'flac-upgrade'));

-- Music Connections end to end (scripts/mc-e2e.sh): the release groups
-- tagave knows. Applied after the app has migrated, before the owner exists.
-- The MBIDs are made up. The other app's seed holds these two albums and a
-- third it suggests (FIXTURE in mc.e2e.mjs). Release groups are shared by
-- every library.
\set ON_ERROR_STOP on
insert into release_groups (id, mbid, title, primary_type, first_release_date, artist_credit) values
  ('00000000-0000-4000-8000-00000000e201', '3f0a1e52-6d6b-4c1e-9a0e-0000000e2e01', 'MC E2E Rated',  'Album', '2020-01-01', '["MC E2E Artist"]'),
  ('00000000-0000-4000-8000-00000000e202', '3f0a1e52-6d6b-4c1e-9a0e-0000000e2e02', 'MC E2E Scored', 'Album', '2021-01-01', '["MC E2E Artist"]');

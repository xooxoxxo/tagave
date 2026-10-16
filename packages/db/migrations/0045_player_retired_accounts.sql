-- Player accounts of people removed with their data (0.9). Deleting the
-- person deletes their player_users row with them (on delete cascade), but
-- their account on the bundled Navidrome would keep the password their phone
-- apps know. The removal leaves the account's name here; the people sync
-- locks it on the server (a random password nobody knows) and drops the row.
-- No reference to users: the person is gone by then.
create table if not exists player_retired_accounts (
  server_key text not null,
  username text not null,
  server_user_id text,
  retired_at timestamptz not null default now(),
  last_error text,
  last_error_at timestamptz,
  primary key (server_key, username)
);

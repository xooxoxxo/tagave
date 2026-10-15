-- People and roles (0.9): an install has more than one account.
--
-- Roles: owner (everything), editor (library care and tag changes, no system
-- settings), listener (browse, search, play, their own ratings, reviews and
-- listens). The old 'viewer' (never handed out) becomes 'listener'. New rows
-- default to the least: setup names its owner explicitly.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'users'::regclass and con.contype = 'c' and att.attname = 'role'
  loop
    execute format('alter table users drop constraint %I', c.conname);
  end loop;
end
$$;

update users set role = 'listener' where role = 'viewer';
alter table users alter column role set default 'listener';
alter table users add constraint users_role_check check (role in ('owner', 'editor', 'listener'));

-- disabled_at: cannot sign in, reversible. removed_at: account closed for
-- good with their data kept (their sign-in rows are deleted and the email is
-- freed); "remove and delete their data" deletes the row instead.
alter table users add column if not exists disabled_at timestamptz;
alter table users add column if not exists removed_at timestamptz;

-- One-time links from Settings › Users. purpose 'invite' makes a new account
-- with this email and role; 'reset' sets a new password for user_id. Only the
-- SHA-256 of the token is stored; the link is shown once.
create table if not exists user_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  purpose text not null check (purpose in ('invite', 'reset')),
  email varchar(255) not null,
  role varchar(20) not null check (role in ('owner', 'editor', 'listener')),
  user_id uuid references users(id) on delete cascade,
  clear_second_factors boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  check (purpose = 'invite' or user_id is not null)
);
create index if not exists idx_user_invites_open on user_invites (expires_at) where used_at is null and revoked_at is null;
-- One open invite per address.
create unique index if not exists user_invites_open_email
  on user_invites (lower(email)) where purpose = 'invite' and used_at is null and revoked_at is null;

-- Saved album-grid views become per person. Existing ones belong to whoever
-- created the library (until now, the only account).
alter table saved_views add column if not exists user_id uuid references users(id) on delete cascade;
update saved_views v set user_id = l.owner_user_id from libraries l where l.id = v.library_id and v.user_id is null;
create index if not exists idx_saved_views_user on saved_views (library_id, user_id);

-- Libraries are shared by everyone on the install; owner_user_id records who
-- created one. Deleting that account must never take the library with it.
alter table libraries drop constraint if exists libraries_owner_user_id_fkey;
alter table libraries add constraint libraries_owner_user_id_fkey
  foreign key (owner_user_id) references users(id) on delete restrict;

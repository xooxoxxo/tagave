-- Better Auth (auth upgrade L1-L4). Additive: the 0.6.x app ignores every
-- new column and table, so rolling the image back needs no down migration.
--
-- The users table is reused (Better Auth `user.modelName = "users"`): its
-- uuids, rows and the nine foreign keys that point at it stay exactly as they
-- are. Better Auth's own sessions, accounts and challenges live in new auth_*
-- tables. The legacy `sessions` table and `users.password_hash` are left in
-- place for the one-release session bridge and for rollback; a later release
-- drops them.
--
-- Every statement is idempotent so a half-applied run can be repeated.

-- Columns Better Auth's user model needs.
alter table users add column if not exists email_verified boolean not null default true;
alter table users add column if not exists image text;
alter table users add column if not exists updated_at timestamptz not null default now();
alter table users add column if not exists two_factor_enabled boolean not null default false;
-- Better Auth keeps the password on the credential account; new owners get
-- no hash here (the app mirrors it while the bridge release lasts).
alter table users alter column password_hash drop not null;
-- Better Auth's `name` is display_name; give the rows that have none a name.
-- The column itself stays nullable so the 0.6.x app keeps working on rollback.
update users set display_name = email where display_name is null or display_name = '';
-- Better Auth looks e-mails up lower-cased; an owner who signed up as
-- "Me@Example.com" must still be found. Skipped if it would collide.
update users u set email = lower(u.email)
 where u.email <> lower(u.email)
   and not exists (select 1 from users o where o.id <> u.id and o.email = lower(u.email));

-- Sign-in methods. provider_id 'credential' holds the password hash.
create table if not exists auth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account_id text not null,
  provider_id text not null,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, account_id)
);
create index if not exists idx_auth_accounts_user on auth_accounts (user_id);

-- One credential account per user, the argon2id hash copied verbatim
-- (account_id = users.id, which is what Better Auth's updatePassword matches).
insert into auth_accounts (user_id, account_id, provider_id, password, created_at, updated_at)
select id, id::text, 'credential', password_hash, created_at, now()
  from users
 where password_hash is not null
on conflict (provider_id, account_id) do nothing;

-- Better Auth sessions: the cookie carries `token` (signed), never `id`.
create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_auth_sessions_user on auth_sessions (user_id);

-- Short-lived values: WebAuthn challenges, the 2FA sign-in step, trusted
-- devices (identifier 'trust-device-...').
create table if not exists auth_verifications (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_auth_verifications_identifier on auth_verifications (identifier);

-- Passkeys and security keys (WebAuthn credentials).
create table if not exists auth_passkeys (
  id uuid primary key default gen_random_uuid(),
  name text,
  public_key text not null,
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,
  counter bigint not null default 0,
  device_type text not null,
  backed_up boolean not null default false,
  transports text,
  aaguid text,
  created_at timestamptz default now(),
  -- tagave's own: the PUBLIC_URL host the credential was made for (WebAuthn
  -- RP ID), so liner-doctor can say when PUBLIC_URL no longer matches.
  rp_id text
);
alter table auth_passkeys add column if not exists rp_id text;
create index if not exists idx_auth_passkeys_user on auth_passkeys (user_id);

-- Authenticator app: secret and backup codes, encrypted with the auth secret
-- derived from APP_SECRET (liner-doctor reseal re-encrypts them).
create table if not exists auth_two_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  secret text not null,
  backup_codes text not null,
  verified boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until timestamptz
);

-- Better Auth's rate limiter, kept in the database so it survives restarts.
create table if not exists auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  count integer not null,
  last_request bigint not null
);

-- Trusted devices ("don't ask for a code on this device for 30 days"), listed
-- and revocable in Settings > Security. Better Auth keeps only an opaque
-- verification row per device; this table names it. `identifier` follows the
-- verification row, which Better Auth rotates on every trusted sign-in.
create table if not exists auth_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  identifier text not null unique,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists idx_auth_trusted_devices_user on auth_trusted_devices (user_id);

-- Music Connections, phase 1: tagave as an OAuth 2.0 provider, so another
-- music app (review-gatherer, ...) can read one person's ratings, collection,
-- listens and identity once that person approves it. The endpoints are
-- routes/connect.ts; tokens are opaque and only their SHA-256 is stored here,
-- as are client secrets and authorization codes.

-- A registered app: one redirect URI each, the one the consent page names.
create table if not exists mc_oauth_clients (
  client_id text primary key,
  client_secret_hash text not null,
  name text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- One authorize request: the consent page shows it (by its random id) to the
-- signed-in person; approving it stores the code's hash and who approved.
create table if not exists mc_oauth_requests (
  id text primary key,
  client_id text not null references mc_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null,
  state text,
  code_challenge text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_id uuid references users(id) on delete cascade,
  decided_at timestamptz,
  code_hash text unique,
  code_expires_at timestamptz,
  code_used_at timestamptz,
  family_id uuid
);
create index if not exists idx_mc_oauth_requests_expires on mc_oauth_requests(expires_at);

-- Issued tokens. One family per approval: a refresh rotates within it, and a
-- rotated refresh token presented again revokes the whole family.
create table if not exists mc_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  client_id text not null references mc_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  scopes text[] not null,
  access_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_token_hash text unique,
  refresh_expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
create index if not exists idx_mc_oauth_tokens_family on mc_oauth_tokens(family_id);
create index if not exists idx_mc_oauth_tokens_user on mc_oauth_tokens(user_id);

-- Linking is per person, not per library: its audit entries carry no library.
alter table audit_log alter column library_id drop not null;

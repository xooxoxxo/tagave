-- Music Connections, phase 2: tagave as a client. A person links tagave to
-- another music app (review-gatherer, another tagave) from Settings ›
-- Connections and tagave pulls that app's feeds (critic scores, identity,
-- wantlist suggestions) every 15 minutes. The routes are
-- api › routes/mcConnections.ts, the pull is worker › jobs/connectionsPull.ts.
--
-- Tokens and client secrets are kept sealed (AES-256-GCM, the APP_SECRET
-- credentials key): never in plain text, never logged.

-- One link: a person and a remote origin.
create table if not exists mc_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- the remote's origin (scheme, host, port), nothing else
  remote_url text not null,
  -- the remote's validated manifest, re-read daily
  manifest jsonb not null,
  manifest_checked_at timestamptz,
  -- the OAuth client tagave registered at the remote
  client_id text not null,
  -- sealed JSON: access token, refresh token, client secret, access expiry; '' once revoked
  sealed_tokens text not null default '',
  -- granted capability scopes (offline_access left out), and what tagave
  -- asked for: a capability the remote offers later is neither
  scopes text[] not null default '{}',
  requested_scopes text[] not null default '{}',
  -- the feed cursor to resume each capability from: { "<capability>": "<cursor>" }
  cursors jsonb not null default '{}'::jsonb,
  -- the landing version each cursor belongs to: a new handler starts its capability afresh
  handler_versions jsonb not null default '{}'::jsonb,
  state text not null default 'active' check (state in ('active', 'needs_reapproval', 'revoked')),
  -- the last pull that finished, and the last one tried
  last_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  -- consecutive failed pulls (backoff 1, 5, 15, then 60 minutes)
  failures integer not null default 0,
  next_attempt_at timestamptz,
  -- per capability: items applied and skipped in the last pull
  last_counts jsonb,
  -- one pull at a time per link, without holding a connection
  pull_lease_until timestamptz,
  pull_lease_owner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, remote_url)
);
create index if not exists idx_mc_links_due on mc_links (next_attempt_at) where state = 'active';

-- An authorization in flight: started from Settings › Connections, finished
-- when the remote sends the browser back. Single use, 15 minutes.
create table if not exists mc_pending (
  -- hex SHA-256 of the OAuth state: the state itself only travels in the URLs
  state_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  remote_url text not null,
  manifest jsonb not null,
  client_id text not null,
  -- PKCE: only the challenge leaves tagave; the verifier is kept sealed
  code_verifier_sealed text not null,
  client_secret_sealed text not null,
  requested_scopes text[] not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_mc_pending_created on mc_pending (created_at);

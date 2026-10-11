-- Step-up: when a session last proved it is its owner (a passkey, the
-- authenticator app or the password, asked again for a sensitive action such
-- as starting an in-app update). A sign-in counts too, through
-- auth_sessions.created_at, so this table only holds re-verifications.
-- Kept small on purpose; Keyward will generalise it later. Additive: older
-- versions ignore the table.
create table if not exists auth_step_ups (
  session_id uuid primary key references auth_sessions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  method text not null check (method in ('passkey', 'totp', 'password')),
  verified_at timestamptz not null default now()
);
create index if not exists idx_auth_step_ups_user on auth_step_ups (user_id);

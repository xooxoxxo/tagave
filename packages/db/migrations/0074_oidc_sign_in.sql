-- Sign in with your own login service (OpenID Connect: Zitadel, Authentik,
-- Authelia, Keycloak, Pocket ID, ...), set up in Settings › Users. One
-- service per install, so one row. The people who use it are ordinary
-- auth_accounts rows (provider_id 'oidc', account_id = the service's `sub`),
-- made only by an explicit link from Account, an invite or, when join is on,
-- a first sign-in.
--
-- client_secret is encrypted with a key derived from APP_SECRET, like the
-- authenticator-app secrets (tagave-doctor reseal re-encrypts it); null for a
-- public client (PKCE only). Additive: older versions ignore the table.
create table if not exists auth_oidc_config (
  id smallint primary key default 1 check (id = 1),
  name varchar(60) not null,
  issuer text not null,
  client_id text not null,
  client_secret text,
  enabled boolean not null default true,
  -- "Anyone from <name> can join": a first sign-in makes a listener account,
  -- optionally only for people in join_group (the groups claim).
  join_enabled boolean not null default false,
  join_group varchar(255),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Step-up through the login service (prompt=login, a fresh auth_time).
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'auth_step_ups'::regclass and con.contype = 'c' and att.attname = 'method'
  loop
    execute format('alter table auth_step_ups drop constraint %I', c.conname);
  end loop;
end
$$;
alter table auth_step_ups add constraint auth_step_ups_method_check
  check (method in ('passkey', 'totp', 'password', 'oidc'));

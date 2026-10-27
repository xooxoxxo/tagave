-- Each person's own preferences that follow them from one device to another
-- (Settings › Appearance). One row per person, made the first time they
-- change something; no row means the defaults. Keyed to users with ON DELETE
-- CASCADE, so the row goes with the person. Additive: older versions ignore it.
--
-- theme: the colour theme, { "theme": "adaptive" | "classic" | "moody" |
-- "mono" | "custom", "custom": { "seed": "#rrggbb", "accent2": "#rrggbb" |
-- null, "mono": bool } | null }. custom is kept while another theme is
-- picked, so Custom comes back as it was. Light / Dark / Auto is not in it:
-- that stays per device. Null until the person picks a theme.
create table if not exists user_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  theme jsonb check (theme is null or jsonb_typeof(theme) = 'object'),
  updated_at timestamptz not null default now()
);

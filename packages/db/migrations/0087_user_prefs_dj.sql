-- The DJ module's Simple mode is each person's own (Settings › Modules › DJ),
-- so it follows them between devices in their user_prefs row (0059), beside
-- the colour theme. The device that plays applies it.
--
-- dj: { "crossfade": "off" | "fixed" | "auto", "lengthSec": 2–12,
-- "beatAligned": bool, "gaplessAlbums": bool }. Null until the person changes
-- one (the defaults: Off, 6 s, Off, On). The install-wide module settings
-- (installed_modules) are the owner's and stay there. Additive: older
-- versions ignore it.
alter table user_prefs add column if not exists dj jsonb check (dj is null or jsonb_typeof(dj) = 'object');

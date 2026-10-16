# Changelog

Every release of tagave, newest first. Assembled from [`release-notes/`](release-notes/) by `node scripts/release-notes.mjs --changelog`; edit the notes there, not here.

## [v0.9.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.9.0) (2026-10-16)

**Minor release (0.8 → 0.9).** tagave now has several people with their own roles, playback and scrobbling; optional parts install from Settings › Modules; every release is signed. Liner is now called tagave everywhere.

### Before you update

- **Going back to 0.8 means a restore.** This update changes the database (migrations 0042–0045). The updater takes a backup first and restores it on its own if the update fails; to return to 0.8 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.9.0/docs/operations.md).
- **Split install (file worker on another computer):** stop `worker-files` there first, update the app computer, then the music computer.
- **Accounts called "viewer" become "listener".** Nothing to do; they keep read access and gain playback if the player is on.
- **Old `LINER_*` settings still work** and log a one-time warning. The updater renames them in `.env` for you. They stop working in 0.10.

### New

- **People and roles.** Invite people from Settings › Users with a one-time link. Roles: *owner* (everything), *editor* (edit the library), *listener* (browse and play). Every API route now checks the role; anything unlisted is refused. ([a19494a](https://github.com/xooxoxxo/tagave/commit/a19494a), [ad58058](https://github.com/xooxoxxo/tagave/commit/ad58058))
- **Your own playback.** Each person gets their own player account, queue and listen history. Phone apps (Subsonic clients) sign in with a per-person app password from Settings › Listening. ([3a17aba](https://github.com/xooxoxxo/tagave/commit/3a17aba), [8b8b785](https://github.com/xooxoxxo/tagave/commit/8b8b785))
- **Scrobbling to Last.fm and ListenBrainz.** The owner adds one Last.fm API key in Settings › Playback › Scrobbling; each person then connects their own account in Settings › Listening. Plays from phone apps count too. ([ca35e04](https://github.com/xooxoxxo/tagave/commit/ca35e04), [74bb32e](https://github.com/xooxoxxo/tagave/commit/74bb32e))
- **Settings › Modules.** Turn the player on or off with one click, no terminal. Needs the in-app updater; without it the page shows the one command to run. ([d084f8a](https://github.com/xooxoxxo/tagave/commit/d084f8a), [cf437c3](https://github.com/xooxoxxo/tagave/commit/cf437c3))
- **Signed releases.** Each release ships a manifest signed with the project's release key, listing every image by digest. The updater and the installer refuse a release that is unsigned, altered or older than the one you run. ([cf437c3](https://github.com/xooxoxxo/tagave/commit/cf437c3), [935060e](https://github.com/xooxoxxo/tagave/commit/935060e))
- **Disk space warnings.** Settings › Storage shows free space; the owner sees a notice at 85 % full, and the doctor fails at 95 %. An update the disk can't take is refused before it starts. ([2cd8584](https://github.com/xooxoxxo/tagave/commit/2cd8584), [c6dc762](https://github.com/xooxoxxo/tagave/commit/c6dc762), [6d1b9c5](https://github.com/xooxoxxo/tagave/commit/6d1b9c5))
- **Backups by kind.** Settings › Backups shows nightly, manual, before-update and before-restore backups separately, each with its own retention. ([8550cae](https://github.com/xooxoxxo/tagave/commit/8550cae), [25f37d5](https://github.com/xooxoxxo/tagave/commit/25f37d5))

### Improved

- **Album page.** Tracks / Editions / About / Activity appear in Maintenance only; the details are two short lines; Play sits in the title row and says how far the player's first scan is. ([b37134d](https://github.com/xooxoxxo/tagave/commit/b37134d))
- **Updates clean up after themselves.** Old images are removed after a successful update. ([7dc16fe](https://github.com/xooxoxxo/tagave/commit/7dc16fe))

### Fixed

- Settings › Storage said "Only the owner can see this page" for every error; it now says what failed, e.g. the database being down. ([e88dcba](https://github.com/xooxoxxo/tagave/commit/e88dcba))
- The updater wrote `.env` and `compose.yml` as root; it now keeps each file's owner and mode. ([f9de5ca](https://github.com/xooxoxxo/tagave/commit/f9de5ca))
- An update could hang while the updater replaced itself; it now waits and says so. ([51c51e1](https://github.com/xooxoxxo/tagave/commit/51c51e1), [a0794bf](https://github.com/xooxoxxo/tagave/commit/a0794bf))
- The doctor could hang creating the backup or cache folder. ([e5b25ed](https://github.com/xooxoxxo/tagave/commit/e5b25ed))
- Removing a person ends their player access and their invite links. ([c6a2cb4](https://github.com/xooxoxxo/tagave/commit/c6a2cb4))
- One-time links and Last.fm tokens no longer appear in the request log. ([4acfa0a](https://github.com/xooxoxxo/tagave/commit/4acfa0a))

### For self-hosters

- **Rename.** Packages are `@tagave/*`; settings are `TAGAVE_*` (`LINER_VERSION` is now `TAGAVE_BUILD_VERSION`); the CLI is `tagave-doctor` (`liner-doctor` still works); new backups are `tagave-<time>.pgdump`, old `liner-*` dumps are still listed and restorable. ([85f852f](https://github.com/xooxoxxo/tagave/commit/85f852f), [3544dca](https://github.com/xooxoxxo/tagave/commit/3544dca))
- **Migrations:** 0042 tagave names, 0043 users and roles, 0044 per-person player, 0045 retired player accounts.
- **Images are pinned by digest** in `compose.yml` (`TAGAVE_DIGEST_*`). The release key's public half is in `deploy/release-keys/` (key id `71fba65e021ad172`).
- **Installer:** `./install-tagave.sh enable-module player` / `disable-module player`; keeps the newest 3 pre-update dumps.

**All changes:** [v0.8.0...v0.9.0](https://github.com/xooxoxxo/tagave/compare/v0.8.0...v0.9.0)

## [v0.8.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.8.0) (2026-10-15)

**Minor release (0.7 → 0.8).** tagave can now play your albums, through an optional player you turn on with one command or a Subsonic server you already run.

### Before you update

- **Going back to 0.7 means a restore.** This update changes the database (migration 0041). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7 later, follow [Roll back](https://github.com/xooxoxxo/tagave/blob/v0.8.0/docs/operations.md#roll-back).
- **The player stays off.** Nothing changes for you unless you turn it on; the new `TAGAVE_PLAYER_*` settings are written only by `enable-player`.

### New

- **Play albums in tagave.** Play and Play from here on the album page, a player bar at the bottom of every page that keeps playing while you browse, the next track loaded ahead, Space to pause, and your keyboard's or phone's media keys. The bar only appears once a player is set up and answers. ([a636864](https://github.com/xooxoxxo/tagave/commit/a636864), [33e465a](https://github.com/xooxoxxo/tagave/commit/33e465a))
- **Settings › Playback.** Choose the bundled player or your own Navidrome (or any Subsonic-compatible server), and pick a streaming quality per device. ([a636864](https://github.com/xooxoxxo/tagave/commit/a636864))
- **The player keeps up with your edits.** After tagave writes tags, it asks the player to rescan just that folder. ([33e465a](https://github.com/xooxoxxo/tagave/commit/33e465a))

### Improved

- tagave calls itself tagave in messages, the API docs and the user agent it sends to MusicBrainz, Discogs and the Cover Art Archive. Setting names, `liner-doctor` and the database name are unchanged. ([f2feac5](https://github.com/xooxoxxo/tagave/commit/f2feac5))

### For self-hosters

- **Turning the player on.** `./install-tagave.sh enable-player` (or `--with-player` when installing) adds the `player` profile, generates Navidrome's admin password and encryption key into `.env` only, and starts it; `disable-player` turns it off and asks before deleting its data. Single-computer installs only for now; on a split install, run your own Navidrome and use Settings › Playback. See [Play your music](https://github.com/xooxoxxo/tagave/blob/v0.8.0/docs/install.md#play-your-music-optional-player). ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958), [f746b64](https://github.com/xooxoxxo/tagave/commit/f746b64))
- **The player is unmodified Navidrome 0.64.0.** It reads the music folder read-only (even with `--music-writable`), keeps its data in the `player-data` volume, and is capped at 512 MB and one core. Its port, 4533 by default (`--player-port`), is meant for phone apps at home: never forward it from your router. ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958))
- **Updates and the player.** When a release pins a new Navidrome, the update copies the player's data first and a roll back puts it back. A player that does not come back after an update only warns. ([772d958](https://github.com/xooxoxxo/tagave/commit/772d958))
- **Migration:** 0041 player (track map, play events, scan requests).
- **New settings** in `compose.yml`: `TAGAVE_PLAYER_URL`, `TAGAVE_PLAYER_USER`, `TAGAVE_PLAYER_PASSWORD`, `TAGAVE_PLAYER_ENCRYPTION_KEY`, `TAGAVE_PLAYER_PORT`, `TAGAVE_PLAYER_IMAGE` (an override; not supported).

**All changes:** [v0.7.7...v0.8.0](https://github.com/xooxoxxo/tagave/compare/v0.7.7...v0.8.0)

## [v0.7.7](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.7) (2026-10-15)

_Generated from the commits; not edited by hand._

**Patch release (0.7.6 → 0.7.7).**

### Before you update

- Nothing to do before this update.

### New

- **web:** Notice a newer server build and reload safely after an update ([949e18e](https://github.com/xooxoxxo/tagave/commit/949e18e))

### Fixed

- **api:** Answer a missing build asset with 404, not the app shell ([6752d58](https://github.com/xooxoxxo/tagave/commit/6752d58))
- **web:** Plain empty states on Home ([8720d30](https://github.com/xooxoxxo/tagave/commit/8720d30))

**All changes:** [v0.7.6...v0.7.7](https://github.com/xooxoxxo/tagave/compare/v0.7.6...v0.7.7)

## [v0.7.6](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.6) (2026-10-13)

_Generated from the commits; not edited by hand._

**Patch release (0.7.5 → 0.7.6).**

### Before you update

- **Going back to 0.7.5 means a restore.** This update changes the database (migration 0040). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7.5 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.6/docs/operations.md).

### New

- **api:** Albums matched by tags belong to their artist ([83d642f](https://github.com/xooxoxxo/tagave/commit/83d642f))
- **web:** The new artist page, name first or like albums ([69c9ed2](https://github.com/xooxoxxo/tagave/commit/69c9ed2))
- **web:** A Storybook component library with story tests ([eae9837](https://github.com/xooxoxxo/tagave/commit/eae9837))

### Fixed

- **core:** Artist dates come from MusicBrainz life-span ([6baf7d4](https://github.com/xooxoxxo/tagave/commit/6baf7d4))
- **web:** The segmented control and tab pill sit dead centre ([c6d6860](https://github.com/xooxoxxo/tagave/commit/c6d6860))
- **worker:** Enrich an artist under a library that holds its albums ([e7990cd](https://github.com/xooxoxxo/tagave/commit/e7990cd))

### For self-hosters

- **Migrations:** 0040 artist tag albums.

**All changes:** [v0.7.5...v0.7.6](https://github.com/xooxoxxo/tagave/compare/v0.7.5...v0.7.6)

## [v0.7.5](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.5) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.4 → 0.7.5).**

### Before you update

- Nothing to do before this update.

### New

- **web:** Opt-in freeze diagnostics in the browser console ([2a13c2b](https://github.com/xooxoxxo/tagave/commit/2a13c2b))

### Fixed

- **web:** Short-album artwork no longer freezes the album page ([d354b9f](https://github.com/xooxoxxo/tagave/commit/d354b9f))
- **web:** The live job stream comes back after a 502 ([a0d6b4f](https://github.com/xooxoxxo/tagave/commit/a0d6b4f))

**All changes:** [v0.7.4...v0.7.5](https://github.com/xooxoxxo/tagave/compare/v0.7.4...v0.7.5)

## [v0.7.4](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.4) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.3 → 0.7.4).**

### Before you update

- Nothing to do before this update.

### Fixed

- **web:** Passkey re-verification can be stopped and never waits on the sign-in request ([0fb6beb](https://github.com/xooxoxxo/tagave/commit/0fb6beb))
- **web:** Settings › Updates matches the other Settings pages ([def8af6](https://github.com/xooxoxxo/tagave/commit/def8af6))

**All changes:** [v0.7.3...v0.7.4](https://github.com/xooxoxxo/tagave/compare/v0.7.3...v0.7.4)

## [v0.7.3](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.3) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.2 → 0.7.3).**

### Before you update

- Nothing to do before this update.

### Fixed

- **web:** Sizes under 1 KB show whole bytes; 0.7.3 ([5d61e34](https://github.com/xooxoxxo/tagave/commit/5d61e34))

**All changes:** [v0.7.2...v0.7.3](https://github.com/xooxoxxo/tagave/compare/v0.7.2...v0.7.3)

## [v0.7.2](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.2) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.1 → 0.7.2).**

### Before you update

- **Settings in `deploy/compose.yml`:** added `TAGAVE_MUSIC_MODE`.

### For self-hosters

- **installer:** --music-writable mounts the music read-write for tag writes ([60518b3](https://github.com/xooxoxxo/tagave/commit/60518b3))

**All changes:** [v0.7.1...v0.7.2](https://github.com/xooxoxxo/tagave/compare/v0.7.1...v0.7.2)

## [v0.7.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.1) (2026-10-11)

_Generated from the commits; not edited by hand._

**Patch release (0.7.0 → 0.7.1).**

### Before you update

- **Going back to 0.7.0 means a restore.** This update changes the database (migration 0039). The updater takes a backup first and restores it on its own if the update fails; to return to 0.7.0 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.1/docs/operations.md).
- **Settings in `deploy/compose.yml`:** added `TAGAVE_INSTALL_DIR`, `TAGAVE_UPDATER_HEALTH_TIMEOUT`, `TAGAVE_UPDATER_MIN_FREE_MB`, `TAGAVE_UPDATER_URL`.

### New

- **auth:** Step-up for one-time sensitive actions (5 minutes) ([9247305](https://github.com/xooxoxxo/tagave/commit/9247305))
- **updates:** Start and follow an in-app update from Settings > Updates ([79c6994](https://github.com/xooxoxxo/tagave/commit/79c6994))

### For self-hosters

- **Migrations:** 0039 auth step up.
- **installer:** --with-updater, enable-updater and disable-updater; docs ([16dffe3](https://github.com/xooxoxxo/tagave/commit/16dffe3))
- **updater:** Opt-in updater service behind the compose profile "updater" ([879c524](https://github.com/xooxoxxo/tagave/commit/879c524))

**All changes:** [v0.7.0...v0.7.1](https://github.com/xooxoxxo/tagave/compare/v0.7.0...v0.7.1)

## [v0.7.0](https://github.com/xooxoxxo/tagave/releases/tag/v0.7.0) (2026-10-11)

_Generated from the commits; not edited by hand._

**Minor release (0.6 → 0.7).**

### Before you update

- **Going back to 0.6 means a restore.** This update changes the database (migrations 0035–0038). The updater takes a backup first and restores it on its own if the update fails; to return to 0.6 later, follow [Going back](https://github.com/xooxoxxo/tagave/blob/v0.7.0/docs/operations.md).
- **Settings in `.env.example`:** added `ALLOWED_ORIGINS`, `TRUST_PROXY`.
- **Settings in `deploy/compose.yml`:** added `ALLOWED_ORIGINS`, `PUBLIC_URL`, `TRUST_PROXY`.

### New

- **auth:** @liner/auth with Better Auth, migration 0035 and the session bridge (L1 wip) ([24e5fa1](https://github.com/xooxoxxo/tagave/commit/24e5fa1))
- **auth:** L1 zero-lockout tests, PUBLIC_URL everywhere, 12-char setup password ([45f4c83](https://github.com/xooxoxxo/tagave/commit/45f4c83))
- **auth:** L3 server side - TOTP, backup codes, revocable trusted devices, reseal ([a7a06ba](https://github.com/xooxoxxo/tagave/commit/a7a06ba))
- **auth:** L4 server side - passkeys and security keys, doctor PUBLIC_URL check ([295a34d](https://github.com/xooxoxxo/tagave/commit/295a34d))
- **review:** Match percent, auto-accept rules, pasted editions ([4c9c190](https://github.com/xooxoxxo/tagave/commit/4c9c190))
- **web:** One page shell, inline back button, contextual Maintenance ([c3a2f4a](https://github.com/xooxoxxo/tagave/commit/c3a2f4a))
- **web:** Raindrop sliding pill for tabs and segmented controls ([f5f5b30](https://github.com/xooxoxxo/tagave/commit/f5f5b30))
- **web:** Pill settles like a small spring, overshoot capped at 3px ([076d336](https://github.com/xooxoxxo/tagave/commit/076d336))
- **web:** Kiosk Home, smooth cover hover, tinted placeholders ([ab81b17](https://github.com/xooxoxxo/tagave/commit/ab81b17))
- **web:** Plan page field filter collapses to one fixed-height line ([033d979](https://github.com/xooxoxxo/tagave/commit/033d979))
- **web:** Fix tags wizard help is a shortcuts popover, not a growing panel ([f9390e4](https://github.com/xooxoxxo/tagave/commit/f9390e4))
- **web:** Album page flow with docking header keys ([365e6d5](https://github.com/xooxoxxo/tagave/commit/365e6d5))
- **web:** L2 sign-in and sign-out on the Better Auth client ([d9e5726](https://github.com/xooxoxxo/tagave/commit/d9e5726))
- **web:** L3 Settings > Security - authenticator app, backup codes, trusted devices, password ([302d827](https://github.com/xooxoxxo/tagave/commit/302d827))
- **web:** L4 passkeys - Security section, passkey sign-in with conditional UI, Protect your account step ([be9eb8e](https://github.com/xooxoxxo/tagave/commit/be9eb8e))
- **web:** Sidebar padding, search placement, wordmark and short-album art settings ([a9dd25f](https://github.com/xooxoxxo/tagave/commit/a9dd25f))
- **web:** Album sections switcher sticks under the header on desktop ([d5f1ab0](https://github.com/xooxoxxo/tagave/commit/d5f1ab0))
- **web:** Review matches compares the edition with what's on disk ([8239dc3](https://github.com/xooxoxxo/tagave/commit/8239dc3))
- Archive finished tag plans; Create plan becomes a plus beside the title ([3226590](https://github.com/xooxoxxo/tagave/commit/3226590))
- Settings > Storage with disk use and tag-change cleanup ([b4045e4](https://github.com/xooxoxxo/tagave/commit/b4045e4))

### Improved

- **web:** Lazy routes, markdown off the album page, one job stream per browser ([6be1b37](https://github.com/xooxoxxo/tagave/commit/6be1b37))
- Precomputed artists list, cheap gap counts, scan-root counts, album detail ([dfeebe4](https://github.com/xooxoxxo/tagave/commit/dfeebe4))

### Fixed

- **api:** Setup-required works without the auth pool (system route tests) ([4051095](https://github.com/xooxoxxo/tagave/commit/4051095))
- **api:** Survive DB connection drops; precompressed, cached static files ([de9c1bc](https://github.com/xooxoxxo/tagave/commit/de9c1bc))
- **api:** Boss test uses pg-boss 12 stop options ([10a5aab](https://github.com/xooxoxxo/tagave/commit/10a5aab))
- **deploy:** Coolify PUBLIC_URL reads the declared SERVICE_URL_APP_3000 ([8072e2b](https://github.com/xooxoxxo/tagave/commit/8072e2b))
- **deploy:** Workers get @liner/auth; manifests copied with their folders ([fdc1235](https://github.com/xooxoxxo/tagave/commit/fdc1235))
- **web:** "Use this edition" waits for the server, then moves the copy once ([b581389](https://github.com/xooxoxxo/tagave/commit/b581389))
- **web:** Give the editions action column a real width ([c32e8f4](https://github.com/xooxoxxo/tagave/commit/c32e8f4))
- **web:** Back after Fix tags no longer reopens the finished wizard ([1328ab0](https://github.com/xooxoxxo/tagave/commit/1328ab0))
- **web:** Tag changes list stacks on phones instead of one letter per line ([337e8f8](https://github.com/xooxoxxo/tagave/commit/337e8f8))
- **web:** Shortcuts popover fits inside the wizard on a phone ([61d5c0b](https://github.com/xooxoxxo/tagave/commit/61d5c0b))
- **web:** Shortcut keys use the kbd radius token ([b5a7399](https://github.com/xooxoxxo/tagave/commit/b5a7399))
- **web:** Kiosk Home fits with its footer; album title reads its own direction ([f6deea0](https://github.com/xooxoxxo/tagave/commit/f6deea0))
- **web:** Album upkeep block takes no room when empty ([f717d08](https://github.com/xooxoxxo/tagave/commit/f717d08))
- **web:** Detail app bar padding and 30px back key; Enriching where the biography lands ([0ec71b3](https://github.com/xooxoxxo/tagave/commit/0ec71b3))
- **web:** Drop the slogan lines ([6f4ab8d](https://github.com/xooxoxxo/tagave/commit/6f4ab8d))
- **web:** Album page on desktop - sections above the tracks, flat header ([fda1ae3](https://github.com/xooxoxxo/tagave/commit/fda1ae3))
- **worker:** Back off retries, keep outages from deferring releases ([37d8c2a](https://github.com/xooxoxxo/tagave/commit/37d8c2a))
- Rr12 merge follow-ups for pg-boss 12 and the page shell contract ([74ca31b](https://github.com/xooxoxxo/tagave/commit/74ca31b))

### For self-hosters

- **Migrations:** 0035 perf indexes artist list, 0036 better auth, 0037 tag plan archive, 0038 auto accept rules.
- Log caps, Postgres sized for the VM, systemd units for split workers ([791e1b2](https://github.com/xooxoxxo/tagave/commit/791e1b2))

**All changes:** [v0.6.1...v0.7.0](https://github.com/xooxoxxo/tagave/compare/v0.6.1...v0.7.0)

## [v0.6.1](https://github.com/xooxoxxo/tagave/releases/tag/v0.6.1) (2026-10-02)

_Generated from the commits; not edited by hand._

**Patch release (0.6.0 → 0.6.1).**

### Before you update

- Nothing to do before this update.

### Fixed

- **ci:** Explicit ifs in the installer test ([10860b9](https://github.com/xooxoxxo/tagave/commit/10860b9))
- **worker:** Replace an album's tracks atomically under a per-album lock ([b817fc3](https://github.com/xooxoxxo/tagave/commit/b817fc3))

**All changes:** [v0.6.0...v0.6.1](https://github.com/xooxoxxo/tagave/compare/v0.6.0...v0.6.1)

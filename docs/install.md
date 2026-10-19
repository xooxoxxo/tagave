# Installation

tagave runs in Docker and Compose v2. The installer below sets everything up from the published images; the manual steps after it build from source instead.

## Prerequisites

You need Docker and Docker Compose 2.20 or later. Compose comes with recent Docker Desktop installs; on Linux, `docker compose` (without a hyphen) is the modern command.

## One-command install

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
```

It asks where your music is, generates the app secret and database password, writes everything to `~/tagave`, starts tagave and waits until it answers. Then open <http://localhost:3100> and create your account. When the setup asks for a scan root, enter `/mnt/music`: that is your music folder as the file worker sees it.

The same script is in the repository, so from a clone `./install-tagave.sh` does the same with the same options.

**Check the script before you run it.** Each release attaches `install-tagave.sh` with its sha256 and its signature (the same Ed25519 release key that signs the release manifest). Download it from the release page instead of piping it, and check it first; [Security: Signed releases](security.md#signed-releases) has the commands. When the installer can check signatures itself (openssl 3), it also checks the release it installs and pins every image by digest; otherwise it says so and pulls by tag.

On a Mac, keep the music folder inside your home folder, or add its folder to Docker's file sharing settings first. Docker runs in a virtual machine there and only sees the folders it shares (colima shares just your home folder); any other folder reaches the worker empty and scans find nothing. The installer checks this after it starts and says so.

Every question has a flag, so it also runs unattended (`--help` lists them all). Options go after a placeholder word:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)" _ --yes --music /srv/music
```

Running it again is safe. It keeps the secrets already in `~/tagave/.env`, backs up any `.env` it changes, and refuses to invent a new database password when a database already exists.

The installer writes the release number it installed to `.env` (for example `TAGAVE_VERSION=0.5.0`), so `docker compose pull` never moves you to a new release by surprise. The installer keeps a copy of itself in `~/tagave`. To see whether a new release is out, and to move to it:

```sh
cd ~/tagave
./install-tagave.sh status
./install-tagave.sh update
```

`update` backs up the database first, restarts the app before the workers, waits until everything is healthy and prints how to roll back. On a split install, run it on the app computer first, then on the music computer. See [Operations: Update](operations.md#update). [Settings › Updates](#updates) shows the same steps and the release notes when a new version is out.

Whatever way you update, the app itself also backs up the database into the `backups` volume before it changes it, and stops if that backup fails; the workers start once the app is done. See [What happens when you update](operations.md#what-happens-when-you-update).

Updating from a version without automatic backups: run the installer again first (or replace `~/tagave/compose.yml` with the current one). The old `compose.yml` has no `backups` volume. Without it, the app writes its backup into a Docker volume with no name, which is easy to lose, and it refuses to back up into a folder that is not mounted.

`~/tagave/.env` holds the secrets that open your database and your stored provider tokens. It is written readable only by you; keep a copy somewhere safe.

### Music on another computer

When the music lives on a different computer than the one that should run the app and database, install in two parts. The file worker, which reads the music, runs next to it; everything else runs on the first computer.

1. On the computer for the app and database:

   ```sh
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)" _ --role app
   ```

   It publishes Postgres (port 5432) for the file worker and writes `~/tagave/files-worker.env`. Postgres listens only on the address you give with `--advertise-address` (or `--db-bind`), so only computers on that network can reach it. See [The database link](#the-database-link) before you pick one.

2. Copy `files-worker.env` to the computer with the music, then run there:

   ```sh
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)" _ \
     --role files --from files-worker.env --music /path/to/music
   ```

   It checks that the database answers before starting the worker. Delete the copied `files-worker.env` afterwards; it holds secrets.

A network share (NFS, SMB) has to be mounted on the worker's computer first; give the folder it is mounted on.

### The database link

In a split install the file worker talks to Postgres over the network. That connection is protected by the generated 64-character password, but it is not encrypted, and three things decide who can reach it:

- **The bind address.** The installer makes Postgres listen on one address of the app computer: the advertise address by default, or `--db-bind`. A home network address (`192.168.x.x`) keeps it off other networks the computer is on. `--db-bind 0.0.0.0` listens on every network and is only safe on a computer that sits on nothing but your home network.
- **Firewalls do not cover it on Linux.** Docker writes its own iptables rules for published ports, and they run before ufw and firewalld. A `ufw allow from <music computer>` rule does nothing for port 5432. To filter by source, add a rule to Docker's `DOCKER-USER` chain, for example:

  ```sh
  sudo iptables -I DOCKER-USER -p tcp --dport 5432 ! -s <music computer address> -j DROP
  ```

- **Across networks you do not trust, use a VPN.** When the two computers are not on the same private network, connect them with [Tailscale](https://tailscale.com) or WireGuard and use the VPN address as `--advertise-address`. The VPN encrypts the link, and Postgres then listens only on the VPN.

## One-click platforms

If you already run a Docker platform, install tagave from its app catalogue instead of the installer. The templates live in [`deploy/templates/`](../deploy/templates/). Each one runs Postgres, the web app and both workers on one host, mounts your music read-only at `/mnt/music`, and needs three values:

| Variable | What to put there |
|---|---|
| `POSTGRES_PASSWORD` | A long random password, letters and digits only. Keep a copy. |
| `APP_SECRET` | At least 32 characters, e.g. the output of `openssl rand -hex 32`. Keep a copy and never change it (see [Security](security.md#app_secret)). |
| `MUSIC_DIR` | The folder with your music on the host, e.g. `/srv/music`. |

Optional: `TAGAVE_VERSION` (image tag, default `latest`; set a release such as `0.4.1` so a redeploy never changes version by surprise), `TAGAVE_PORT` (default 3100), `TZ` (default UTC).

Data lives in two named volumes: `pgdata` (the database) and `cache` (cover art, thumbnails, backups). After the first start, open the app, create your account and enter `/mnt/music` as the music folder.

### Portainer

1. **Settings › App Templates**: set the URL to `https://raw.githubusercontent.com/xooxoxxo/tagave/main/deploy/templates/portainer/templates.json` and save.
2. **Templates › Application**: pick **tagave**.
3. Fill in the database password, the app secret and the music folder, then press **Deploy the stack**.
4. Open `http://<host>:3100`.

To update: **Stacks › tagave › Editor**, set `TAGAVE_VERSION` to the new release, turn on **Re-pull image and redeploy**, press **Update the stack**.

Portainer can also deploy [`deploy/templates/compose.yml`](../deploy/templates/compose.yml) directly: **Stacks › Add stack › Repository**, repository `https://github.com/xooxoxxo/tagave`, compose path `deploy/templates/compose.yml`, and the variables above.

### Dokploy

1. Create a project, then **Create Service › Compose**.
2. Paste [`deploy/templates/dokploy/docker-compose.yml`](../deploy/templates/dokploy/docker-compose.yml) as the compose file.
3. **Environment**: add `POSTGRES_PASSWORD`, `APP_SECRET` and `MUSIC_DIR` (plus `TAGAVE_INSTALL_METHOD=dokploy`, so Settings › Updates shows the Dokploy steps). [`template.toml`](../deploy/templates/dokploy/template.toml) shows the values the blueprint would generate.
4. **Domains**: add a domain for service `app`, port `3000`.
5. Press **Deploy**.

To update: set `TAGAVE_VERSION` in **Environment**, then **Deploy**.

### Coolify

1. **Projects › your project › New Resource › Docker Compose Empty**.
2. Paste [`deploy/templates/coolify/tagave.yml`](../deploy/templates/coolify/tagave.yml). Coolify generates the database password and the app secret (the `SERVICE_PASSWORD_64_*` variables) and gives the app a URL.
3. **Environment Variables**: set `MUSIC_DIR`.
4. Press **Deploy**. Coolify serves the app over https, so the template sets `ALLOW_INSECURE_HTTP=false`.

To update: set `TAGAVE_VERSION` in **Environment Variables**, then **Redeploy**.

Coolify keeps the generated secrets in its own settings. Copy `SERVICE_PASSWORD_64_APPSECRET` somewhere safe: a restored database needs the same app secret.

### Unraid

[`deploy/templates/unraid/tagave.xml`](../deploy/templates/unraid/tagave.xml) is a draft Community Apps template for the web app container only. tagave needs Postgres and two workers besides it, so on Unraid today the simpler route is the **Docker Compose Manager** plugin with [`deploy/templates/compose.yml`](../deploy/templates/compose.yml): add a new stack, paste the file, set the three variables in its `.env`, and **Compose Up**.

To use the draft template anyway: install the official Postgres 16 template, then in **Docker › Add Container › Template** paste the template URL `https://raw.githubusercontent.com/xooxoxxo/tagave/main/deploy/templates/unraid/tagave.xml`, and add the two worker containers by hand with the `tagave-worker` image and the `TAGAVE_QUEUES` lists from `deploy/templates/compose.yml`.

### Any other Docker UI

Synology Container Manager (**Project › Create**), CasaOS and similar tools accept [`deploy/templates/compose.yml`](../deploy/templates/compose.yml) as is. Give them the three variables above.

## Updates

tagave checks for new versions on its own. Every 12 hours the server sends one request to the GitHub releases list of the official repository. The request carries nothing about you, the server or your library, and there is no other telemetry.

When a newer release is out, a small dot appears on **Settings** and **Settings › Updates** shows:

- the release notes;
- the update steps for the way this server was installed, first: the installer, plain Docker Compose, a source checkout, or one of the platforms above;
- for a release marked **requires attention** (it needs a step from you), the notes stay open and the steps appear only after you tick that you have read them.

**Skip this version** hides the dot until a later release appears.

To turn checks off, untick **Check for new versions** on that page, or set `TAGAVE_UPDATE_FEED=off` in the app's environment to turn them off for the whole server. For a fork, the page takes another GitHub releases API URL (`https://api.github.com/repos/OWNER/REPO/releases`) and nothing else, because the server fetches it on its own. `TAGAVE_UPDATE_FEED` can hold any https URL; only whoever runs the server can set it.

Under **If something goes wrong**, the page shows how to go back to the version you had, using the backup its own update steps took: the installer's `backups/pre-update-…` folder, the `tagave-before-<version>.pgdump` file for plain Compose and source installs, or `/cache/backups` inside the app container on the platforms. The commands stop at the first one that fails, so the older version never starts on a database that was not restored.

The update page decides which steps to show first from `TAGAVE_INSTALL_METHOD` (`installer`, `compose`, `source`, `portainer`, `dokploy`, `coolify` or `unraid`). The templates set it and the installer's `.env` is recognised on its own; you only need it when you wrote your own compose file for a platform.

### Updating from the app (optional updater)

Installs made with `install-tagave.sh` can add a small updater service, so **Settings › Updates** performs the update itself instead of showing a command. It is off unless you ask for it, because it holds the Docker socket (see [security](security.md#the-in-app-updater) before you turn it on).

```sh
./install-tagave.sh --with-updater ...      # when installing
./install-tagave.sh enable-updater          # on an existing install, from the install folder
./install-tagave.sh disable-updater         # turn it off again
```

With the updater on, the page offers **Update to x.y.z** (and a list of the newer releases to pick from). Only the owner can start an update. If your sign-in is older than five minutes, the page first asks you to confirm it is you: with a passkey or security key if you have one, otherwise with the authenticator app, otherwise with your password.

The updater then works through these steps, and the page shows each one with the time it took and a log:

1. **Check**: the release's signed manifest checks out (signed with the tagave release key, for exactly this version, not older than what runs here; see [Security: Signed releases](security.md#signed-releases)), the install is healthy now, there is room on disk for the new images and a backup with 3 GB to spare (see [Free space before updates](operations.md#free-space-before-updates)), and every image downloads by the digest the manifest pins for this computer's architecture, each one checked after the pull. Nothing has changed yet; a manifest or image that does not check out ends the run here with the check that failed.
2. **Check the database**: the free space is measured again, now with what the new version's database changes need. The updater takes no backup of its own: the new app writes a checked dump to the backups folder right before it updates the database, and that is the one a roll back restores. Only when the app would not take one (`TAGAVE_SKIP_PREMIGRATE_BACKUP=1`, or it would reuse an older one) does the updater run `tagave-doctor backup --kind before-update` here (see [In-app updates](operations.md#in-app-updates)).
3. **Switch**: `TAGAVE_VERSION`, the image digests (`TAGAVE_DIGEST_*`) in `.env` and the compose files are set to the new release, and the signed manifest is kept next to them (`release-manifest.json`). The old files stay next to them as `.env.bak` and `compose.yml.bak`.
4. **Pull** and **restart**: the workers stop, the new app starts (and updates the database), then the workers start again.
5. **Check every part**: `/api/v1/health` answers ok, the app reports the new version, and every worker on this computer sends heartbeats from it. It waits up to 10 minutes (`TAGAVE_UPDATER_HEALTH_TIMEOUT`, in seconds).

While it runs, the page shows what the current step does (the download in megabytes, what the new app is doing, how many workers run the new version). A step that does not move for 2 minutes (`TAGAVE_UPDATER_STALL_SECONDS`) is looked into: the page then says the likely cause, such as a full disk, a container that keeps restarting or runs out of memory, a port in use, a failing health check or Postgres recovering, and what to do. The update itself goes on until the step succeeds or times out.

If a step after the switch fails, the updater rolls back on its own: it puts the old `.env` and compose files back and starts the old version. When the new version had already changed the database, it stops the app and workers first and restores the backup the new app took before it changed it (or the updater's own from step 2) with `tagave-doctor restore` (the database it replaces is kept under another name). If there is no such backup, or it cannot be read, it does not roll back: the old version must not run on the changed database, so the new one stays, and the page says what to do. The page then says what failed and what was rolled back.

The run is kept by the updater, not by the app, so the page keeps following it while the app restarts, and after a reload. The updater itself moves to the new release last, once the rest reports healthy.

On a split install the updater updates the app computer; run `install-tagave.sh update` on the music computer afterwards, as before.

### Optional modules (Settings › Modules)

Optional parts of tagave (the player is the first) are listed in **Settings › Modules**, owner only. The list is the module catalogue in the signed manifest of the release this server runs, so a module that arrives in a later release shows up once you update to it; nothing else needs installing. Each module shows what it adds, how much memory and disk it takes, and whether it is off, being turned on or off, on, failed (with the reason), or waiting for an update to bring in a new image.

With the updater, **Turn on** asks you to confirm it is you (like an update), then shows each step: the signature and the disk are checked and its images are pulled by digest and checked; its settings go into `.env` (generated secrets once, kept when it is turned off); it starts; it must report healthy. If any step fails, the updater rolls back and the page says why. **Turn off** stops it and takes it out of the configuration; its data stays unless you tick **Also delete its data**.

Turned off with its data kept, a module only loses what it does: its background work stops, and turning it on again picks up where it was. **Also delete its data** deletes exactly the module's own data: its Docker volumes, and its rows in tagave's database, and nothing of your library, your people, reviews or ratings. For the player that is Navidrome's database and, in tagave, the player's library (which song on Navidrome is which track), plays and play counts, and the connected Last.fm and ListenBrainz accounts with their keys. While a player server of your own is set up in Settings › Playback, that server keeps working: only the bundled player's rows go (and those of libraries your server does not serve); your server's accounts, play counts, plays, listens and scrobbles, and the Last.fm and ListenBrainz connections, stay. The listens the player recorded stay: they are your history, like the ones you add by hand. A second box, **Also delete the listens the player recorded**, deletes those too; listens you added yourself stay either way. The run's log says how many rows of each kind went and how many listens were kept.

Without the updater, each module shows the command that does the same from the install folder:

```sh
./install-tagave.sh enable-module player
./install-tagave.sh disable-module player            # asks before deleting its data; --delete-data deletes it
./install-tagave.sh disable-module player --delete-data --delete-history   # the player's listens too
```

It runs the same steps, with the release's own updater image as a one-off container. Only modules in tagave's signed catalogue can be installed; there are no third-party or community modules.

## Play your music (optional player)

tagave can play your albums. The player module is [Navidrome](https://www.navidrome.org), an open-source music server, run unmodified next to tagave. tagave plays albums through it in the browser, and phone apps can use the same Navidrome to stream your library. It is off unless you ask for it: **Settings › Modules › Player › Turn on** (with the updater), or from the install folder:

```sh
./install-tagave.sh --with-player ...      # when installing (role all)
./install-tagave.sh enable-player          # on an existing install, from the install folder
./install-tagave.sh disable-player         # turn it off again
```

`enable-player` explains what it changes and asks first (`--yes` skips the question, `--no-start` writes the settings and starts nothing). It:

- adds `player` to `COMPOSE_PROFILES` in `.env`;
- generates an admin password and an encryption key for Navidrome, once, and keeps them only in `.env` (`TAGAVE_PLAYER_PASSWORD`, `TAGAVE_PLAYER_ENCRYPTION_KEY`, readable only by you). The installer never prints them;
- writes `TAGAVE_PLAYER_URL=http://player:4533`, `TAGAVE_PLAYER_USER=admin` and `TAGAVE_PLAYER_PORT`;
- starts Navidrome and restarts the app, which picks up the player.

Navidrome reads your music folder read-only, always, even when you installed with `--music-writable`. It keeps its own database in a Docker volume of its own (`player-data`). That database is SQLite, so the volume must stay on a local disk, never on NFS.

**The port.** Navidrome is published on port 4533 of this computer (`--player-port N` picks another), so phone apps on your network can reach it. Keep it inside your home network, or reach it from outside through a VPN or your HTTPS reverse proxy. Never forward it from your router. See [Security: the player](security.md#the-player).

**One account per person.** tagave gives everyone on the install their own Navidrome user (made the first time they play, or within a minute of being added; locked when their tagave account is disabled). Their plays, play counts, ratings and stars are theirs, and tagave streams as them, never as the admin. The passwords are random, sealed with `APP_SECRET`, and never shown.

**Phone apps.** Symfonium, Amperfy, play:Sub, Substreamer and Tempus log in to Navidrome directly, not through tagave. Each person sets a password for apps in **Settings › Listening** (tagave shows their Navidrome user name there), then enters this computer's address, port 4533, that user name and that password in the app. Plays from the app come back to tagave as theirs within a minute or two, and are scrobbled like plays in tagave.

**The first scan.** Navidrome scans the whole library once when it first starts, and again every 24 hours. The file watcher is off, because it does not work over NFS; instead tagave asks Navidrome for a scan after it writes tags. On a large library on a NAS the first scan can take hours. Albums play once Navidrome has scanned them; the installer does not wait for it. Until then an album's Play is greyed out with how far the first scan is, and it turns on by itself when the scan reaches the album.

**Resources.** Plan for about 150 MB more memory, and one more core while Navidrome scans or transcodes. The compose file caps it at 512 MB (`mem_limit`) and one core (`cpus: 1.0`), so a scan cannot starve the database on a small machine.

**Turning it off.** `disable-player` stops and removes the Navidrome container, removes `player` from `COMPOSE_PROFILES`, clears `TAGAVE_PLAYER_URL` and restarts the app. It keeps the password and the key in `.env`, so `enable-player` later reopens the same Navidrome data. It then asks whether to delete the player's data: the `player-data` volume (Navidrome's own plays, stars and users) and the player's rows in tagave's database (its library, plays, play counts and the connected Last.fm and ListenBrainz accounts). Then, separately, whether to delete the listens it recorded; listens you added yourself always stay. Both answers default to no; `--delete-data` and `--delete-history` answer yes. With `--yes`, or without a terminal, it keeps everything and prints how to delete it later:

```sh
docker volume rm tagave_player-data
docker compose exec app node packages/doctor/dist/cli.js purge-module player                    # its rows in tagave; listens stay
docker compose exec app node packages/doctor/dist/cli.js purge-module player --delete-history   # and the listens it recorded
```

`purge-module` deletes the player's rows in one transaction (only the bundled player's while a server of your own is set up, as above) and refuses while the player is on (`TAGAVE_PLAYER_URL` set); running it again deletes nothing. A player server of your own (Settings › Playback) and the Last.fm API key stay: they are settings, not the player's data.

**Listens and scrobbling.** When someone has heard at least half of an album's tracks within six hours, in tagave or in a phone app, tagave adds a listen of that release to the album page (only for them). Each play also goes to the person's own Last.fm and ListenBrainz, once: tagave sends every scrobble itself, and Navidrome's own scrobbling is turned off in `compose.yml` so nothing is counted twice. A track counts when it is longer than 30 seconds and half of it (or four minutes) was heard.

- **ListenBrainz** needs nothing from the owner: each person pastes their user token (listenbrainz.org › Settings) in **Settings › Listening**.
- **Last.fm** needs an API key for your server, made once by the owner:
  1. Open https://www.last.fm/api/account/create and sign in with any Last.fm account.
  2. Under **Application name**, type a name (for example "tagave at home"). Leave every other field empty.
  3. Press **Submit**. Last.fm shows an **API key** and a **Shared secret**.
  4. In tagave, open **Settings › Playback › Scrobbling**, paste both, and press **Save**. tagave checks them with Last.fm and stores them sealed with `APP_SECRET`. No restart is needed.

  Then each person presses **Connect Last.fm** in **Settings › Listening**, allows tagave on last.fm and comes back. (`TAGAVE_LASTFM_API_KEY` and `TAGAVE_LASTFM_SECRET` in `.env` also work; the ones saved in Settings win.)

To check it for real after setting it up: play one album through to the end in tagave, wait a minute, and look at your profile on last.fm and listenbrainz.org; **Settings › Listening › Recently played** shows each play with "Scrobbled to …" or the reason it was not.

**Your own server instead.** If you already run Navidrome (or another Subsonic-compatible server), leave the module off and enter its address, a user name and a password under **Settings › Playback**. tagave stores the password sealed with `APP_SECRET`, like the other provider secrets. Everyone plays through that account unless they add their own login on that server in **Settings › Listening** (then their plays, ratings and phone-app plays are theirs; if that server already scrobbles for them, they say so there and tagave sends nothing). tagave finds the file behind each track by its path. For exact matching, open Navidrome's **Players** page and turn on **Report real path** for the player named `tagave` (it appears after tagave first connects). The bundled player does this for you.

**Split installs.** For now the bundled player works only when everything runs on one computer (`--role all`): it has to run next to both the music and the app. On a split install the installer refuses `--with-player` and `enable-player`; run your own Navidrome on the music computer and point Settings › Playback at it.

**Versions.** Each tagave release pins one Navidrome version in `compose.yml`, the newest release that has been out for at least 30 days. `install-tagave.sh update` and the in-app updater pull it with the rest. Navidrome changes its database only forward, so when a release pins a new Navidrome, the update stops the player and copies its data to `/data/snapshots/pre-update` inside the volume first, and the roll back puts that copy back (see [Operations: Roll back](operations.md#roll-back)). If the player does not come back after an update, the update warns and leaves tagave on the new release. `TAGAVE_PLAYER_IMAGE` in `.env` overrides the image; that is not supported.

The one-click platform templates do not include the player yet. On those platforms, run Navidrome yourself and use Settings › Playback.

## Manual install (build from source)

The rest of this guide builds the images yourself with `docker-compose.prod.yml`, the way a development checkout runs.

## Generate your app secret

Generate a 32-byte random secret for session encryption and credential storage:

```sh
openssl rand -hex 32
```

Save this value; you will need it in the next step.

## Create .env

Copy the example environment file:

```sh
cp .env.example .env
```

Then edit `.env` and paste the generated secret as `APP_SECRET`, and set `PUBLIC_URL` (next section).

## Public URL

`PUBLIC_URL` is **required**: the app does not start without it. Set it to the address you type in the browser to open tagave, scheme, host and port only:

```sh
PUBLIC_URL=http://localhost:3100          # only on this computer
PUBLIC_URL=http://192.168.1.10:3100       # from other computers at home
PUBLIC_URL=https://music.example.com      # behind an https reverse proxy
```

- Sign-in is accepted only from this address. If you open tagave at more than one address, list the others in `ALLOWED_ORIGINS`, comma separated (`ALLOWED_ORIGINS=http://localhost:3100`).
- Passkeys and security keys are tied to its **host name** for good: a passkey made at `music.example.com` does not work at `192.168.1.10`, and changing the host name later means adding your passkeys again. Pick the name you will keep.
- Browsers allow passkeys only on https addresses and on `localhost`. Over plain http on another host name, password and authenticator-app sign-in still work.
- The one-command installer writes `PUBLIC_URL` for you (this computer's address, or `--public-url`).

## Start the stack

```sh
docker compose -f docker-compose.prod.yml up -d
```

The app listens on `http://localhost:3100` by default. Port is configurable via the `TAGAVE_PORT` env var; Postgres listens on `5432` (configurable via `POSTGRES_PORT`).

## First-run setup

Open http://localhost:3100. A fresh install opens the setup wizard, which walks through five steps:

1. **System check**: the database, its schema and the workers. Anything that fails says how to fix it. The account cannot be created while the database or its schema fails; a missing worker only holds up scanning.
2. **Owner account**: email, name, password (at least 12 characters) and a **contact** for MusicBrainz and Discogs (an email address or a website; required for external lookups).
3. **Music folder**: the path to your library **as the worker sees it** (with the bundled Compose workers, `/mnt/music`). The worker checks the folder and the wizard shows what it found, with a fix for a missing path, a permission problem or a read-only mount.
4. **First album**: start the first scan and follow it until the first album is identified. A Discogs token (cover images, 25→55 requests/min) and an AcoustID key are optional on the same page.
5. **Protect your account** (skippable): add a passkey or a security key such as a YubiKey, or set up an authenticator app and save its backup codes. Passkeys need `PUBLIC_URL` to be the address you are on, over https or `localhost`; the step says so when it is not. Skipped, Settings › Security keeps reminding you.

Afterwards, **Settings › System status** runs the same checks at any time, each with a fix for anything that fails. From a shell, `tagave-doctor doctor` prints the same checks and fixes. The worker check passes when the running workers together take every kind of work (music folders, identification, album details, tag changes); on a split install it names the work no running worker takes. Set `EXPECT_WORKERS=0` in the app environment only while you run no worker on purpose.

### Adding people

Everyone in the household can have their own account. As the owner, open **Settings › Users**, enter the person's email address, pick a role and choose **Make invite link**:

- **Listener**: browse, search and play, with their own ratings, reviews and listens.
- **Editor**: also library care and tag changes, but no install settings.
- **Owner**: everything, including settings, updates, backups and people.

tagave does not send email: copy the link and send it yourself. It works once, for 7 days. The person opens it, sets their name and a password (at least 12 characters), and can add a passkey or an authenticator app straight away. Someone who forgot their password or lost their phone gets a new **set-password link** from the menu next to their name. See [Security › People and roles](security.md#people-and-roles) for what each role can do.

## Connect your music

Scanning, identification, and tag writing happen in a **worker**: a separate process that must see your music files on the filesystem. The app container usually cannot, so the worker runs elsewhere.

Two options: workers as Docker Compose services (recommended), or a worker on another machine.

### Option A: workers as Compose services (recommended)

Put the host path to your music library in `.env`:

```sh
MUSIC_DIR=/path/to/music
```

Then start the stack with the `workers` profile:

```sh
docker compose -f docker-compose.prod.yml --profile workers up -d
```

This adds two services: `worker-files` (scanning, clustering, cover art, tag plans; your library is mounted read-only at `/mnt/music`, or read-write with `--music-writable` so applying a tag plan can write tags) and `worker-identify` (MusicBrainz and Discogs lookups, enrichment, reviews, artist refreshes, track linking; no file access).

When you register a scan root in the setup, use the container path `/mnt/music` (not your host path).

Later, all `up`, `down`, and `stop` commands must include `--profile workers`, otherwise the worker containers stay running or are left in an unclear state.

### Option B: worker on another machine

If your music is on a separate host, build and run the worker there:

```sh
pnpm install && pnpm -r build
```

Then run one or both worker processes:

**File worker** (scanning, clustering, cover art, tag plans):

```sh
DATABASE_URL=postgres://tagave:…@db-host:5432/tagave APP_SECRET=<same value as the app> \
TAGAVE_QUEUES=scan.root,scan.dir,scan.sweep,scan.parse,cluster.dir,cluster.repairDiscs,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,facets.refresh,fingerprint.album,fingerprint.sweep,tags.preview,tags.apply,tags.revert \
node packages/worker/dist/index.js
```

**Identify worker** (MusicBrainz/Discogs lookups, enrichment, reviews, artist refreshes, track linking; can run anywhere with internet):

```sh
DATABASE_URL=postgres://tagave:…@db-host:5432/tagave APP_SECRET=<same value as the app> \
TAGAVE_QUEUES=identify.album,identify.acoustid,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich,artists.refresh,artist.refresh,tracks.link,acoustid.lookup \
node packages/worker/dist/index.js
```

The `TAGAVE_QUEUES` env var limits which job queues a process claims from (default: all). Between them the workers must cover every queue; a queue no worker lists never runs. `APP_SECRET` must match the app's so the worker can decrypt stored provider credentials.

See `scripts/deploy.sh` for one way to keep a worker host in step with the app (rsync, build, migrate, pidfile restart).

### Critical: workers must be running

Until a worker is listening to the database, a new scan root stays `pending` and starting a scan returns `409 Conflict`. This is the most common source of confusion; if your scans do not start, check that a worker process is running and connected.

## Behind a reverse proxy

If you proxy the app (nginx, Caddy, etc.):
- Set `PUBLIC_URL=https://your-domain.com` in `.env`; with https the session cookie gets the `secure` flag
- Keep `ALLOW_INSECURE_HTTP=false` (default) so the owner account cannot be created over plain http
- Set `TRUST_PROXY=1` (one proxy in front; or the proxies' addresses, `TRUST_PROXY=172.16.0.0/12`) when the proxy sets `X-Forwarded-For`, so rate limits apply per client (docs/security.md › Reverse proxy and client addresses)

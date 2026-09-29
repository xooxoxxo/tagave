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

On a Mac, keep the music folder inside your home folder, or add its folder to Docker's file sharing settings first. Docker runs in a virtual machine there and only sees the folders it shares (colima shares just your home folder); any other folder reaches the worker empty and scans find nothing. The installer checks this after it starts and says so.

Every question has a flag, so it also runs unattended (`--help` lists them all). Options go after a placeholder word:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)" _ --yes --music /srv/music
```

Running it again is safe. It keeps the secrets already in `~/tagave/.env`, backs up any `.env` it changes, and refuses to invent a new database password when a database already exists. To update, run `docker compose pull && docker compose up -d` in `~/tagave`, or run the installer again; [Settings › Updates](#updates) shows the exact steps and the release notes when a new version is out.

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

To use the draft template anyway: install the official Postgres 16 template, then in **Docker › Add Container › Template** paste the template URL `https://raw.githubusercontent.com/xooxoxxo/tagave/main/deploy/templates/unraid/tagave.xml`, and add the two worker containers by hand with the `tagave-worker` image and the `LINER_QUEUES` lists from `deploy/templates/compose.yml`.

### Any other Docker UI

Synology Container Manager (**Project › Create**), CasaOS and similar tools accept [`deploy/templates/compose.yml`](../deploy/templates/compose.yml) as is. Give them the three variables above.

## Updates

tagave checks for new versions on its own. Every 12 hours the server sends one request to the GitHub releases list of the official repository. The request carries nothing about you, the server or your library, and there is no other telemetry.

When a newer release is out, a small dot appears on **Settings** and **Settings › Updates** shows:

- the release notes;
- the update steps for the way this server was installed, first: the installer, plain Docker Compose, a source checkout, or one of the platforms above;
- for a release marked **requires attention** (it needs a step from you), the notes stay open and the steps appear only after you tick that you have read them.

**Skip this version** hides the dot until a later release appears.

To turn checks off, untick **Check for new versions** on that page, or set `TAGAVE_UPDATE_FEED=off` in the app's environment to turn them off for the whole server. `TAGAVE_UPDATE_FEED` can also hold another GitHub releases API URL, for a fork.

The update page decides which steps to show first from `TAGAVE_INSTALL_METHOD` (`installer`, `compose`, `source`, `portainer`, `dokploy`, `coolify` or `unraid`). The templates set it and the installer's `.env` is recognised on its own; you only need it when you wrote your own compose file for a platform.

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

Then edit `.env` and paste the generated secret as `APP_SECRET`.

## Start the stack

```sh
docker compose -f docker-compose.prod.yml up -d
```

The app listens on `http://localhost:3100` by default. Port is configurable via the `LINER_PORT` env var; Postgres listens on `5432` (configurable via `POSTGRES_PORT`).

## First-run setup

Open http://localhost:3100. A fresh install opens the setup wizard, which walks through four steps:

1. **System check**: the database, its schema and the workers. Anything that fails says how to fix it. The account cannot be created while the database or its schema fails; a missing worker only holds up scanning.
2. **Owner account**: email, name, password (at least 8 characters) and a **contact** for MusicBrainz and Discogs (an email address or a website; required for external lookups).
3. **Music folder**: the path to your library **as the worker sees it** (with the bundled Compose workers, `/mnt/music`). The worker checks the folder and the wizard shows what it found, with a fix for a missing path, a permission problem or a read-only mount.
4. **First album**: start the first scan and follow it until the first album is identified. A Discogs token (cover images, 25→55 requests/min) and an AcoustID key are optional on the same page.

Afterwards, **Settings › System status** runs the same checks at any time, each with a fix for anything that fails. From a shell, `liner-doctor doctor` prints the same checks and fixes. The worker check passes when the running workers together take every kind of work (music folders, identification, album details, tag changes); on a split install it names the work no running worker takes. Set `EXPECT_WORKERS=0` in the app environment only while you run no worker on purpose.

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

This adds two services: `worker-files` (scanning, clustering, cover art, tag plans; your library is mounted read-only at `/mnt/music`) and `worker-identify` (MusicBrainz and Discogs lookups, enrichment, reviews, artist refreshes, track linking; no file access).

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
DATABASE_URL=postgres://liner:…@db-host:5432/liner APP_SECRET=<same value as the app> \
LINER_QUEUES=scan.root,scan.dir,scan.sweep,scan.parse,cluster.dir,cluster.repairDiscs,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,facets.refresh,fingerprint.album,fingerprint.sweep,tags.preview,tags.apply,tags.revert \
node packages/worker/dist/index.js
```

**Identify worker** (MusicBrainz/Discogs lookups, enrichment, reviews, artist refreshes, track linking; can run anywhere with internet):

```sh
DATABASE_URL=postgres://liner:…@db-host:5432/liner APP_SECRET=<same value as the app> \
LINER_QUEUES=identify.album,identify.acoustid,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich,artists.refresh,artist.refresh,tracks.link,acoustid.lookup \
node packages/worker/dist/index.js
```

The `LINER_QUEUES` env var limits which job queues a process claims from (default: all). Between them the workers must cover every queue; a queue no worker lists never runs. `APP_SECRET` must match the app's so the worker can decrypt stored provider credentials.

See `scripts/deploy.sh` for one way to keep a worker host in step with the app (rsync, build, migrate, pidfile restart).

### Critical: workers must be running

Until a worker is listening to the database, a new scan root stays `pending` and starting a scan returns `409 Conflict`. This is the most common source of confusion; if your scans do not start, check that a worker process is running and connected.

## Behind a reverse proxy

If you proxy the app (nginx, Caddy, etc.):
- Set `PUBLIC_URL=https://your-domain.com` in `.env`
- Keep `ALLOW_INSECURE_HTTP=false` (default) so cookies use the `secure` flag
- The app will serve the correct CORS origins and redirect URIs

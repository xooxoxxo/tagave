# Installation

tagave runs in Docker and Compose v2. This guide covers setup, starting the stack, and connecting your music library.

## Prerequisites

You need Docker and Docker Compose v2 (or later). Compose v2 comes with recent Docker Desktop installs; on Linux, `docker compose` (without a hyphen) is the modern command.

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

1. Open http://localhost:3100
2. Click **Setup** to create the library owner account (email, password, display name)
3. Enter a **contact string** (e.g., `name@example.com`; required for external API lookups)
4. Add a **scan root**, the path to your music library on the worker host
5. (Optional) Add a Discogs token for cover images and higher rate limits (25→55 requests/min)
6. Start your first scan

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

This adds two services: `worker-files` (scanning, clustering, cover art; your library is mounted read-only at `/mnt/music`) and `worker-identify` (MusicBrainz and Discogs lookups, enrichment, reviews; no file access).

When you register a scan root in the setup, use the container path `/mnt/music` (not your host path).

Later, all `up`, `down`, and `stop` commands must include `--profile workers`, otherwise the worker containers stay running or are left in an unclear state.

### Option B: worker on another machine

If your music is on a separate host, build and run the worker there:

```sh
pnpm install && pnpm -r build
```

Then run one or both worker processes:

**File worker** (scanning, clustering, cover art):

```sh
DATABASE_URL=postgres://liner:…@db-host:5432/liner APP_SECRET=<same value as the app> \
LINER_QUEUES=scan.root,scan.dir,scan.sweep,scan.parse,cluster.dir,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,facets.refresh,fingerprint.album,fingerprint.sweep \
node packages/worker/dist/index.js
```

**Identify worker** (MusicBrainz/Discogs lookups, enrichment, reviews; can run anywhere with internet):

```sh
DATABASE_URL=postgres://liner:…@db-host:5432/liner APP_SECRET=<same value as the app> \
LINER_QUEUES=identify.album,identify.acoustid,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich,acoustid.lookup \
node packages/worker/dist/index.js
```

The `LINER_QUEUES` env var limits which job queues a process claims from (default: all). `APP_SECRET` must match the app's so the worker can decrypt stored provider credentials.

See `scripts/deploy.sh` for one way to keep a worker host in step with the app (rsync, build, migrate, pidfile restart).

### Critical: workers must be running

Until a worker is listening to the database, a new scan root stays `pending` and starting a scan returns `409 Conflict`. This is the most common source of confusion; if your scans do not start, check that a worker process is running and connected.

## Behind a reverse proxy

If you proxy the app (nginx, Caddy, etc.):
- Set `PUBLIC_URL=https://your-domain.com` in `.env`
- Keep `ALLOW_INSECURE_HTTP=false` (default) so cookies use the `secure` flag
- The app will serve the correct CORS origins and redirect URIs

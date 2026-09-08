# Liner — Music Archive Catalog

Self-hosted catalog brain for a large music archive: identifies every album
against MusicBrainz and Discogs, fixes tags safely (journaled, revertible),
shows gaps (incomplete albums, missing discography, unripped vinyl), and keeps
your ratings, reviews, and listens next to the records.

Not a player. Navidrome/Plexamp/Roon play; Liner knows.

## Quick start

**Prerequisites:** Docker and Docker Compose v2.

### 1. Generate your app secret

Generate a 32-byte random secret (required for session encryption):

```sh
openssl rand -hex 32
```

### 2. Create `.env` from the example

```sh
cp .env.example .env
```

Then edit `.env` and paste the generated secret as `APP_SECRET`.

### 3. Start the stack

```sh
docker compose -f docker-compose.prod.yml up -d
```

The app listens on `http://localhost:3100` (port configurable via `LINER_PORT` env var).
Postgres listens on `5432` (configurable via `POSTGRES_PORT`).

### 4. First-run setup

1. Open http://localhost:3100
2. Click **Setup** to create the library owner account (email, password, display name)
3. Enter a **contact string** (e.g., `name@example.com`; required for external API lookups)
4. Add a **scan root** — the path to your music library on the worker host
5. (Optional) Add a Discogs token for cover images and higher rate limits (25→55 requests/min)
6. Start your first scan

### 5. Connect your music

Scanning, identification and tag writing happen in the **worker** — a separate
process that has to see your music files. Two ways to run it; both talk to the
same Postgres.

**Option A: workers as Compose services (recommended)**

Put the host path of your library in `.env`:

```sh
MUSIC_DIR=/path/to/music
```

and start the stack with the `workers` profile. It adds two services:
`worker-files` (scanning, clustering, cover art; the library is mounted
read-only at `/mnt/music`) and `worker-identify` (MusicBrainz/Discogs lookups,
enrichment, reviews; no file access):

```sh
docker compose -f docker-compose.prod.yml --profile workers up -d
```

Register the scan root as `/mnt/music` — the path inside the container. Later
`up`/`down`/`stop` calls need `--profile workers` too, otherwise they leave the
worker containers untouched.

**Option B: worker on another machine**

Build the workspace on a host that has the library mounted and run the worker
against the same database:

```sh
pnpm install && pnpm -r build
DATABASE_URL=postgres://liner:…@db-host:5432/liner APP_SECRET=<same value as the app> \
LINER_QUEUES=scan.root,scan.parse,cluster.dir,art.fetch,art.sweep,gaps.recompute,queue.autoaccept \
node packages/worker/dist/index.js
```

`LINER_QUEUES` limits which queues a process works (default: all). The list
above is the file worker; a second process with
`LINER_QUEUES=identify.album,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich`
is the identify worker, and can run anywhere with internet access. `APP_SECRET`
must match the app's so the worker can open the sealed provider credentials.
`scripts/deploy.sh` shows one way to keep such a host in step with the app
(rsync, build, migrate, pidfile restart).

Until a worker is listening, a new scan root stays `pending` and starting a
scan returns `409 Conflict`.

### 6. Health check

Verify all systems are configured (add `--expect-workers 0` while no worker
runs yet):

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor
```

Or on a worker host: `pnpm doctor`.

### Data & backups

- **Database:** `pgdata` volume
- **Cache:** `cache` volume (thumbnails, converted audio, database dumps)

Take a verified dump of the database — custom `pg_dump` format, checked with
`pg_restore --list` before the command reports success, older dumps pruned to
the newest 14:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js backup --keep 14
```

Dumps land in `/cache/backups/liner-<timestamp>.pgdump` inside the app
container (`--out DIR` or `LINER_BACKUP_DIR` changes that). Copy them off the
host — the cache volume is not a backup location:

```sh
docker compose -f docker-compose.prod.yml cp app:/cache/backups ./backups
```

Restore into an empty database:

```sh
pg_restore --no-owner --dbname=postgres://liner:…@localhost:5432/liner ./backups/liner-<timestamp>.pgdump
```

Run `backup` before every upgrade, and put it on a nightly timer once you rely
on the catalog.

### Behind a reverse proxy

If you proxy the app (nginx, Caddy, etc.):
- Set `PUBLIC_URL=https://your-domain.com` in `.env`
- Keep `ALLOW_INSECURE_HTTP=false` (default) so cookies use `secure` flag
- The app will serve the correct CORS origins and redirect URIs

## Moving workers into containers

If you started with a worker on another machine (Option B above) and want the
`workers` profile to take over, do this once. Nothing in the database changes
as long as the library ends up at the same path inside the container as the
scan root you registered; otherwise edit the scan root's path in Settings after
step 3.

**Prerequisites**

- The Compose host can read the library — local disk, or an NFS/SMB export that
  includes this host — at the path you set as `MUSIC_DIR` in `.env`.
- `APP_SECRET` in `.env` is the value the app already runs with; the workers
  open the same sealed credentials.

**Cutover**

1. Build the worker images while the old workers keep running. Pass the same
   build args `scripts/deploy.sh` passes for the app — they are what
   Settings › Updates and the doctor `Build Versions` check compare:
   ```sh
   GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \
   docker compose -f docker-compose.prod.yml --profile workers build
   ```
2. Stop the old workers on their host (`scripts/deploy.sh` tracks them in
   `~/liner-worker.pid` and `~/liner-identify.pid`; under systemd,
   `systemctl stop`). A worker finishes its current job on `SIGTERM`; give it
   up to 30 s, then `kill -9` one that ignores it — a ghost of the old build
   keeps a database connection and shows up in `Build Versions` as a lagging sha.
3. Start the containers:
   ```sh
   docker compose -f docker-compose.prod.yml --profile workers up -d
   ```
4. Verify. The first heartbeat lands about 30 s after boot; `Worker Heartbeat`
   and `Build Versions` must both pass, and Settings › Updates lists both
   workers at the app's sha:
   ```sh
   curl -s http://localhost:3100/api/v1/health        # "2 live worker(s) detected"
   docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor --offline
   ```
5. Retire the old launchers so a reboot of that host does not bring the bare
   workers back.

**Rollback**

```sh
docker compose -f docker-compose.prod.yml stop worker-files worker-identify
```

then relaunch the host workers. Both topologies can coexist — jobs are claimed
from the same queue — but keep the builds at the same sha, or `Build Versions`
warns until you do.

`scripts/smoke.sh` runs exactly this topology on a throwaway stack (postgres,
app, both workers, a temp music dir, a `backup` round-trip) and is the release
gate for the images.

## Security

### APP_SECRET

`APP_SECRET` is a required 32+ byte random value used for:
- **Credential encryption:** Discogs tokens, AcoustID keys stored in the database are encrypted with AES-256-GCM using a key derived from `APP_SECRET`
- **Session signing:** (future) session tokens will be signed with `APP_SECRET`

**Generation:**
```sh
openssl rand -hex 32  # 64 hex characters = 32 bytes
```

**Rotation:**
When you need to rotate the secret (e.g., after a compromise):
1. Generate a new secret: `openssl rand -hex 32`
2. Set it as `APP_SECRET` and keep the old one in `LINER_OLD_APP_SECRET`
3. Run the reseal command:
   ```sh
   LINER_OLD_APP_SECRET=<old_secret> APP_SECRET=<new_secret> \
   node packages/doctor/dist/cli.js reseal
   ```
   Or in Docker: `docker compose exec app node packages/doctor/dist/cli.js reseal`
4. Update your `.env` to remove `LINER_OLD_APP_SECRET` and keep only the new `APP_SECRET`

### Backup security

- **Database backups:** include encrypted credential material (safe without `APP_SECRET`)
- **Cache volume:** thumbnails and converted audio; not sensitive
- **Ensure `APP_SECRET` is backed up separately** in your secret store (e.g., HashiCorp Vault, AWS Secrets Manager, `.env.backup`)

### TLS/HTTPS

- In production, always use TLS (reverse proxy with HTTPS)
- Development: set `ALLOW_INSECURE_HTTP=true` to allow HTTP (cookies will not have `secure` flag)

## Features

### Artist pages

Every artist linked to your library's albums has a profile showing their name, type (Person, Group, …), country, years active, and a biography excerpt from Wikipedia with full attribution and a link to the full article (CC BY-SA 4.0). Click any artist name to browse their discography as it appears in your library, grouped by type (Album, EP, Single, Live, Compilation, Other). Each release shows what you own: digital, physical, or both. Toggle **Follow** to curate your own artist list.

### Genres

Each album is tagged with effective genres (up to three) computed from Discogs and MusicBrainz data and weighted to surface the most relevant: top genres appear as chips, secondary styles as muted tags. Go to **Settings › Genres** to customize the genre taxonomy: edit the whitelist (default: Rock, Electronic, Pop, Jazz, 13 more), add aliases to map niche styles to top-level categories (e.g., black metal → Metal), and adjust the maximum number of genres per album.

### Background jobs

The catalog enriches artist data and resolves credits in the background:

- **`artists.resolve`** queries MusicBrainz for release group credits, discovering canonical artist names and identities; it runs every 10 minutes (throttled to ~2 requests/min to respect rate limits).
- **`artists.enrich`** fetches artist biographies, type, country, and years from MusicBrainz, Wikidata, and Wikipedia; it runs on-demand when an artist page is opened (if not already enriched in the last 7 days).

Both jobs are queued in the Postgres `pg-boss` queue. When you split workers by
role, the process whose `LINER_QUEUES` names them claims them — in the Compose
setup that is `worker-identify`:

```
LINER_QUEUES=identify.album,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich
```

## Development

```sh
pnpm install
docker compose up postgres -d
pnpm db:migrate
pnpm dev
```

## Layout

| Package | Purpose |
|---|---|
| `packages/shared` | zod schemas and types shared API ↔ web |
| `packages/db` | Drizzle schema + SQL migrations (Postgres 16) |
| `packages/core` | domain logic: matching engine, provider gateway, tag schema |
| `packages/api` | Fastify API (`/api/v1`, OpenAPI 3.1) + serves the web build |
| `packages/worker` | scanner, clusterer, matcher, enricher, tag writer (pg-boss jobs) |
| `packages/web` | React SPA |
| `packages/doctor` | Health and configuration diagnostics |

Planning documents live outside this repo.

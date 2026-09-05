# Liner — Music Archive Catalog

Self-hosted catalog brain for a large music archive: identifies every album
against MusicBrainz and Discogs, fixes tags safely (journaled, revertible),
shows gaps (incomplete albums, missing discography, unripped vinyl), and keeps
your ratings, reviews, and listens next to the records.

Not a player. Navidrome/Plexamp/Roon play; Liner knows.

## Quick start

```sh
cp .env.example .env   # set APP_SECRET
docker compose up
```

Open http://localhost:3000 and follow first-run setup.

## Health

Run diagnostics to verify the system is configured correctly:

```sh
# In the app container
docker compose exec app node packages/doctor/dist/cli.js doctor

# On the worker host
pnpm doctor
```

Each check reports one of: **pass** (ok), **warn** (degraded but operational), **fail** (broken), or **skip** (not applicable).

| Check | What it verifies |
|---|---|
| `database` | Postgres is reachable and running the correct schema version |
| `migrations` | All pending migrations have been applied |
| `contactString` | Contact string is set in library settings (required for external API calls) |
| `workerHeartbeat` | Worker processes are running and reporting status (expect 2: file scanner + identifier) |
| `scanRoots` | Configured music directories are readable and mounted, with fresh validation |
| `cacheDir` | Cache directory is writable for thumbnails and converted audio |
| `providers` | MusicBrainz and Discogs APIs are reachable; AcoustID/Wikidata checked if configured |
| `appSecret` | App secret is set and long enough (>= 32 chars, app host only) |

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

Planning documents live outside this repo.

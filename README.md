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

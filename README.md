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

The app validates scan roots against the **worker** — the background service that handles file scanning, identification, and tag writing.

**Option A: Worker as a Compose service** (untested in this repo)
```yaml
# Uncomment the worker block in docker-compose.prod.yml and bind your music:
volumes:
  - /path/to/music:/music:ro
```
Then update settings to use `/music` as the scan root. Restart with `docker compose -f docker-compose.prod.yml up -d`.

**Option B: Worker on the host** (see `scripts/deploy.sh`)
Run `pnpm -r build && node packages/worker/dist/index.js` on a machine with access to your music library. The worker connects to the same Postgres database.

The first scan will fail until a worker is listening (the API returns `409 Conflict` and marks the root `pending`).

### 6. Health check

Verify all systems are configured:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor
```

Or on the worker host: `pnpm doctor`.

### Data & backups

- **Database:** pgdata volume (docker-compose.prod.yml)
- **Cache:** cache volume (thumbnails, converted audio)
- **Backup database:** `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U liner liner | gzip > liner-backup-$(date +%s).sql.gz`

### Behind a reverse proxy

If you proxy the app (nginx, Caddy, etc.):
- Set `PUBLIC_URL=https://your-domain.com` in `.env`
- Keep `ALLOW_INSECURE_HTTP=false` (default) so cookies use `secure` flag
- The app will serve the correct CORS origins and redirect URIs

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

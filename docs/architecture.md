# Architecture

The tagave catalog is built on a modular package structure with a clear separation between the API and web frontend, persistent background job workers, and domain logic. This guide covers the layout, how work flows between components, and how to set up a development environment.

## Package layout

| Package | Purpose |
|---|---|
| `packages/shared` | zod schemas and types shared API ↔ web |
| `packages/db` | Drizzle schema + SQL migrations (Postgres 16) |
| `packages/core` | domain logic: matching engine, provider gateway, tag schema |
| `packages/api` | Fastify API (`/api/v1`, OpenAPI 3.1) + serves the web build |
| `packages/worker` | scanner, clusterer, matcher, enricher, tag writer (pg-boss jobs) |
| `packages/web` | React SPA |
| `packages/doctor` | health and configuration diagnostics |

## How work is split between app and worker

The app is a stateless API and web frontend. All long-running operations (scanning the library, identifying albums, enriching metadata, writing tags) run as background jobs in separate processes called workers. This split exists because:

- Scanning and tag writing need direct access to your music files, so workers need the library mounted.
- Metadata enrichment and identification require internet access and spend rate-limit budgets with providers like MusicBrainz and Discogs. Decoupling them allows you to run workers on different machines with different capabilities.
- The app can be updated and restarted without losing in-flight work. Workers store their state in Postgres and can be replaced at any time.

## Background jobs with pg-boss

All queued work runs through a job queue stored in Postgres. The job system uses [pg-boss](https://github.com/timgit/pg-boss), which creates named queues for different types of work. When you start a worker, you tell it which queues to claim work from using the `TAGAVE_QUEUES` environment variable.

For example:

**File worker** (scanning, clustering, tag writing):
```
TAGAVE_QUEUES=scan.root,scan.dir,scan.sweep,scan.parse,cluster.dir,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,facets.refresh,fingerprint.album,fingerprint.sweep
```

**Identify worker** (metadata enrichment):
```
TAGAVE_QUEUES=identify.album,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich,acoustid.lookup
```

Two important enrichment jobs show how the system works:

- **`artists.resolve`** queries MusicBrainz for release group credits every 10 minutes (throttled to ~2 requests/min to respect rate limits). It discovers canonical artist names and identities and stores them for display on artist pages.
- **`artists.enrich`** fetches artist biographies, type, country, and years from MusicBrainz, Wikidata, and Wikipedia on demand when an artist page is opened (if not already enriched in the last 7 days). This job is the expensive one in terms of rate-limit budget.

Both jobs are named in the identify worker's queue list. When you split workers by role, the process whose `TAGAVE_QUEUES` includes `artists.resolve` and `artists.enrich` claims them from the queue.

## Worker roles in practice

In a typical deployment, two worker processes run: a file worker and an identify worker. The file worker needs the music library mounted (read-only) and handles scanning, clustering, and tag writing. The identify worker needs internet access to query MusicBrainz and Discogs, and it spends the provider rate-limit budget on metadata enrichment and identification. The isolation allows you to scale them independently: run multiple identify workers in regions with low latency to your providers, and keep the file worker on the host where your library is mounted.

## Development

Set up a local environment in four steps:

```sh
pnpm install
docker compose up postgres -d
pnpm db:migrate
pnpm dev
```

This starts Postgres, runs all migrations, and starts the API and web development servers. The API listens on `http://localhost:3000` and hot-reloads on file changes.

To test jobs in development, start a worker in a separate terminal:

```sh
pnpm -r build && node packages/worker/dist/index.js
```

The worker will claim jobs from all queues by default (when `TAGAVE_QUEUES` is unset).

## Releasing

Each release has notes written for the people who run tagave: `release-notes/vX.Y.Z.md`, shown in the app on Settings › Updates and as the GitHub release text. [`release-notes/v0.9.0.md`](../release-notes/v0.9.0.md) is the model: the release type and a one-sentence summary, then Before you update, New, Improved, Fixed, For self-hosters, and the compare link, with every bullet linking its commits.

**Commit messages feed the draft.** Write them as conventional commits, `type(scope): subject`. `feat` goes under New, `fix` under Fixed, `perf` under Improved; the `deploy`, `installer`, `doctor` and `updater` scopes and `docs(install)` / `docs(operations)` go under For self-hosters; `chore`, `ci`, `test`, `build` and other docs are left out. Two footers matter:

```text
feat(deploy)!: one compose file for every role

BREAKING CHANGE: split installs must re-run the installer on the music computer.
Requires-Attention: Stop worker-files on the music computer before updating.
```

`BREAKING CHANGE:` (or a `!` after the type) marks a breaking change; before 1.0 it needs a minor bump, from 1.0 on a major one. `Requires-Attention:` is anything the owner must do or know before updating. Either one puts a `**Requires attention:**` line in the notes, and the app then asks the owner to confirm reading them before it updates. New migrations and added, removed or renamed settings in `.env.example` and `deploy/compose.yml` are found on their own.

**Cutting a release**, on an up-to-date `main`:

1. `scripts/release.sh X.Y.Z` sets the version in `package.json` and writes a draft of `release-notes/vX.Y.Z.md` from the commits since the last release. It refuses a version that bumps less than the commits need (a feature or a breaking change in a patch release).
2. Edit the draft: write the summary, merge bullets about the same thing into one, say what changed in plain words, keep the commit links, and remove the `<!-- draft: edit before release -->` line and every `TODO:`.
3. `scripts/release.sh X.Y.Z` again: it checks the notes, rebuilds [`CHANGELOG.md`](../CHANGELOG.md), commits `chore: X.Y.Z`, tags `vX.Y.Z` and prints the two `git push` commands. Nothing is pushed until you run them.

CI refuses a release tag whose notes file is missing or still a draft, before it builds any image. A pre-release tag (`v1.2.0-rc.1`) may go without notes; its release then carries a generated draft. To see a draft without releasing: `node scripts/release-notes.mjs --version X.Y.Z`.

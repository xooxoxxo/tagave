# Operations

This page covers the health check, backups, what happens when you update, and the cutover from external workers to containers. Return here when you need to verify the system is running, take a backup before an upgrade, or move workers into the Compose stack.

## Health check

Verify all systems are configured:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor
```

Add `--expect-workers 0` while no worker runs yet. Or on a worker host: `pnpm doctor`.

## Where data lives

- **Database:** `pgdata` volume
- **Cache:** `cache` volume (thumbnails, converted audio)
- **Backups:** `backups` volume, mounted at `/backups` in the app container (the automatic backups taken before each update, and `backup` dumps). Set `BACKUP_DIR` in `.env` to a folder on the host instead.

## Taking a backup

Take a verified dump of the database using custom `pg_dump` format, checked with `pg_restore --list` before the command reports success, and older dumps pruned to the newest 14:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js backup --keep 14
```

Dumps land in `/backups/liner-<timestamp>.pgdump` inside the app container.
The `liner-` prefix is the old project name and is still what the code writes;
it is a filename, not a display string, so it has deliberately not been renamed. Use `--out DIR` or set `LINER_BACKUP_DIR` to change the location.

Copy dumps off the host. A Docker volume on the same disk is not a backup location:

```sh
docker compose -f docker-compose.prod.yml cp app:/backups ./backups
```

Restore into an empty database:

```sh
pg_restore --no-owner --dbname=postgres://liner:…@localhost:5432/liner ./backups/liner-<timestamp>.pgdump
```

Put `backup` on a nightly timer once you rely on the catalog. The app also takes its own backup before every update that changes the database (below).

## What happens when you update

When the app starts, it updates the database to match its version (migrations). In order:

1. **One at a time.** The app holds a database lock for the whole update. A second app that starts at the same moment waits ("another tagave process is migrating the database"), then finds nothing left to do.
2. **Never onto a newer database.** If a newer version of tagave has already updated the database, an older app refuses to start. Update the app, or roll back as below.
3. **Backup first.** If an existing database has updates to apply, the app writes `pre-migrate-<timestamp>.pgdump` into `/backups`, checks it with `pg_restore --list`, and records it. It keeps the newest 5 (`LINER_PREMIGRATE_BACKUP_KEEP`). If the backup fails, the app does not touch the database and exits with a message starting `Not migrating:` that says why (usually a full disk, a folder it cannot write, or a missing `pg_dump`). A new, empty database needs no backup.
4. **Then the migrations**, each in its own transaction.

The workers wait for the app: in the Compose files they start only once the app is healthy. A worker that is newer than the database waits until the app has updated it (up to `LINER_SCHEMA_WAIT_SECONDS`, 15 minutes by default, then it exits and Compose restarts it). A worker that is older than the database refuses to start, and a running worker stops when the app updates the database under it; its log says `will not run:` and which version it needs. On a split install, update the app computer first, then the music computer.

The status page (Settings › System) and `liner-doctor doctor` show this as two checks: **Database schema** (pending updates, or a database newer than this build) and **Backups before updates** (whether the next backup can be written, and where the last one is).

Overrides, for when you know why you need them:

| Setting | Effect |
|---|---|
| `LINER_SKIP_PREMIGRATE_BACKUP=1` | Update without the backup. The status page warns afterwards. With the installer, set `TAGAVE_SKIP_PREMIGRATE_BACKUP=1` in `.env`. |
| `LINER_ALLOW_SCHEMA_SKEW=1` | Let an app or worker run on a database a newer version updated. With the installer: `TAGAVE_ALLOW_SCHEMA_SKEW=1`. |
| `LINER_BACKUP_DIR` | Where the app writes backups inside its container (default `/backups`). |
| `LINER_PREMIGRATE_BACKUP_KEEP` | How many pre-update backups to keep (default 5). With the installer: `TAGAVE_PREMIGRATE_BACKUP_KEEP`. |

Outside Docker (a source checkout), the app needs `pg_dump` and `pg_restore` of the same major version as the server on its `PATH` (or `PG_DUMP` and `PG_RESTORE` pointing at them) before it will apply an update. On a throwaway development database you can set `LINER_SKIP_PREMIGRATE_BACKUP=1` instead.

### Roll back an update

Migrations only go forward, so going back means restoring the backup the update took:

1. Stop everything: `docker compose down` (the volumes stay).
2. Set `TAGAVE_VERSION` in `.env` back to the version you had.
3. Start only the database: `docker compose up -d postgres`.
4. Restore the newest `pre-migrate-*.pgdump` into an empty database:
   ```sh
   docker compose exec -T postgres dropdb -U liner liner
   docker compose exec -T postgres createdb -U liner liner
   docker compose run --rm --no-deps -T app pg_restore --no-owner \
     --dbname=postgres://liner:<password>@postgres:5432/liner /backups/pre-migrate-<timestamp>.pgdump
   ```
5. `docker compose up -d`.

## Moving workers into containers

If you started with a worker on another machine and want the `workers` profile to take over, follow this procedure once. Nothing in the database changes as long as the library ends up at the same path inside the container as the scan root you registered. If paths differ, edit the scan root's path in Settings after step 3.

### Prerequisites

- The Compose host can read the library at the path you set as `MUSIC_DIR` in `.env` (local disk, or NFS/SMB export).
- `APP_SECRET` in `.env` is the value the app already runs with. Workers open the same sealed credentials.

### Cutover

1. Build the worker images while the old workers keep running. Pass the same `GIT_SHA` and `BUILT_AT` build args the app image was built with (they are what Settings › Updates and the doctor `Build Versions` check compare):
   ```sh
   GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \
   docker compose -f docker-compose.prod.yml --profile workers build
   ```

2. Stop the old workers on their host, the same way you started them: `kill -TERM <pid>` for a process you launched by hand, `systemctl stop` (or your supervisor's equivalent) for a managed one. A worker finishes its current job on `SIGTERM`; give it up to 30 seconds, then `kill -9` one that ignores it. A ghost of the old build keeps a database connection and shows up in `Build Versions` as a lagging sha.

3. Start the containers:
   ```sh
   docker compose -f docker-compose.prod.yml --profile workers up -d
   ```

4. Verify. The first heartbeat lands as soon as a worker is ready. `Worker Heartbeat` and `Build Versions` must both pass, and Settings › Updates must list both workers at the app's sha:
   ```sh
   curl -s http://localhost:3100/api/v1/health        # "2 live worker(s) detected"
   docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor --offline
   ```

5. Retire the old launchers so a reboot of that host does not bring the bare workers back.

### Rollback

If you need to revert:

```sh
docker compose -f docker-compose.prod.yml stop worker-files worker-identify
```

Then relaunch the host workers. Both topologies can coexist, because jobs are claimed from the same queue, but keep the builds at the same sha, or `Build Versions` will warn until you do.

## Release gate

`scripts/smoke.sh` runs exactly this topology on a throwaway stack (postgres, app, both workers, a temp music dir, and a `backup` round-trip) and is the release gate for the images.

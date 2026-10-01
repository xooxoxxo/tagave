# Operations

This page covers the health check, updates, what happens when you update, backups, roll back and restore, and the cutover from external workers to containers. Return here when you need to verify the system is running, move to a new release, undo one, or move workers into the Compose stack.

The update, roll back and restore sections assume an install made with `install-tagave.sh` (in `~/tagave` unless you passed `--dir`). The other sections show the commands for a source build with `docker-compose.prod.yml`; on an installer install, drop `-f docker-compose.prod.yml` and run them in the install folder.

## Update

The installer pins the release in `.env` (`TAGAVE_VERSION=0.5.0`), so nothing changes until you ask. Check what runs and whether a newer release is out:

```sh
cd ~/tagave
./install-tagave.sh status
```

Move to the newest release, or to a given one:

```sh
./install-tagave.sh update
./install-tagave.sh update --version 0.5.0 --yes
./install-tagave.sh update --dry-run      # show the plan, change nothing
```

`update` does this, in order, and stops at the first step that fails:

1. Compares the version in `.env`, the version the app reports, and the target, and shows the release notes link. Read the notes before you go on: a release that changes how tagave is set up says so there.
2. Copies `.env`, the compose files and a verified `pg_dump` of the database to `backups/pre-update-<old version>-<time>/` in the install folder. The dump is taken by the database container and read back with `pg_restore --list` before anything changes.
3. Writes the new `TAGAVE_VERSION`, fetches the compose files of that release and pulls its images.
4. Stops the workers, starts the new app and waits until it is healthy. The app applies database changes when it starts, so this can take a few minutes on a large library.
5. Starts the workers and waits until `/api/v1/health` reports the database and migrations as ok, the app on the new version, and every worker on the same build.
6. Prints the exact commands to roll back to the version you came from.

An `.env` from an older installer may say `TAGAVE_VERSION=latest`, which moves with every pull. `update` then treats the version that runs now as the one you came from: it names the backup after it, pins it in the saved `.env`, and refuses to go below it. If it cannot tell which version runs (the app is stopped and the local image names none), it stops unless you pass `--yes`. Re-running the installer on such an install pins the running version too; it does not update.

tagave does not go back to an older version through `update`. Database changes only go forward, so going back means restoring the backup taken before the update (next section).

**Split install.** First stop the file worker on the music computer (`docker compose stop worker-files` there), so old code does not write to the database while it changes; `update` on the app computer warns when it still sees that worker checking in. Then run `update` on the app computer. Then run it on the music computer: there it asks the app for its version (`TAGAVE_APP_URL` in `.env`, or `--app-url http://<app address>:3100`), refuses any other version, and only pulls and restarts the file worker. Until the music computer is updated, Settings › Updates and the doctor's Build Versions check warn that the workers run different builds.

**Without the installer script.** The same steps by hand, in the install folder:

```sh
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > pre-update.pgdump
sed -i.bak 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=0.5.0/' .env
docker compose pull
docker compose stop worker-identify worker-files
docker compose up -d app          # wait until `docker compose ps` shows it healthy
docker compose up -d
```

### Update notifications

tagave does not update itself, and nothing in the compose file needs access to the Docker socket. To hear about new releases:

- Settings › Updates in the app lists new releases once a release feed is set there.
- [Diun](https://github.com/crazy-max/diun) only notifies (Discord, Gotify, Pushover, Slack, Telegram, email and others). The compose file already carries its labels (`diun.enable`, `diun.watch_repo`, and `diun.include_tags` limited to release numbers), so run Diun with `watchByDefault: false` and it watches only tagave.
- [What's Up Docker](https://github.com/getwud/wud) shows available updates in a dashboard and can notify. The compose file carries `wud.watch` and `wud.tag.include` for it. Use it to notify, not to replace the containers: an automatic update skips the backup and the app-before-workers order above, and it cannot change the version pinned in `.env`.

Watchtower was archived in December 2025 and does not work with current Docker Engine releases; do not use it for tagave.

## Roll back

When an update goes wrong, `update` prints the commands for your install, with the real folder names filled in. They look like this, run in the install folder (`B` is the `backups/pre-update-…` folder the update wrote):

```sh
# split install: first stop the file worker on the music computer
#   docker compose stop worker-files
docker compose stop app worker-identify worker-files
cp -p B/.env B/*.yml .                  # the old version and compose files
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < B/database.pgdump
docker compose pull && docker compose up -d
```

If the update failed before the new app started, the database was not touched: copying the files back and running `docker compose pull && docker compose up -d` is enough, and `update` says so.

On a split install, roll the music computer back too: copy its saved `.env` back from its own `backups/pre-update-…` folder, then `docker compose pull && docker compose up -d`. Or run `./install-tagave.sh update` there once the app computer is back; it follows the app's version.

Anything the app did between the update and the roll back (new scans, edits, accepted matches) is lost with the restore. Scans can be run again.

## Restore

To restore any dump (one from `update`, or one from the `backup` command below) into an installer install:

1. Get the dump onto the host. `update` dumps are already in `backups/`. A `backup` dump lives in the cache volume:
   ```sh
   docker compose cp app:/cache/backups/liner-<timestamp>.pgdump ./backups/
   ```
2. Check it can be read:
   ```sh
   docker compose exec -T postgres pg_restore --list < ./backups/<file>.pgdump | head
   ```
3. Stop everything that writes to the database (on a split install, the file worker on the music computer too):
   ```sh
   docker compose stop app worker-identify worker-files
   ```
4. Replace the database with the dump:
   ```sh
   docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < ./backups/<file>.pgdump
   ```
5. Start tagave. Run the version the dump was taken with, or a newer one: the app applies any missing database changes when it starts. A dump from a newer version than the one you run does not work; set `TAGAVE_VERSION` to at least that version first.
   ```sh
   docker compose up -d
   ./install-tagave.sh status
   ```

Restore with the `.env` the dump was taken under: the dump holds provider tokens sealed with its `APP_SECRET`, and a different secret cannot open them.

## Health check

Verify all systems are configured:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor
```

Add `--expect-workers 0` while no worker runs yet. Or on a worker host: `pnpm doctor`.

## Where data lives

- **Database:** `pgdata` volume
- **Backups:** `backups` volume, mounted at `/backups` in the app container (nightly, manual and before-update dumps), or a folder on the host when `TAGAVE_BACKUP_DIR` is set in `.env`
- **Cache:** `cache` volume (thumbnails, converted audio). The cache is not a backup location.

The commands below are for an install made with the installer: run them in its folder (`~/tagave` unless you chose another). For a source install, add `-f docker-compose.prod.yml` after `docker compose`.

## Backups

The app backs the database up every night and keeps a set of recent dumps, and it takes one on its own before an update changes the database (see [What happens when you update](#what-happens-when-you-update)). Settings › Backups lists them, takes one on demand, downloads or deletes one, and changes the schedule and how many are kept.

Every backup is a custom-format `pg_dump`, read back in full with `pg_restore --list` before it counts as written. A dump that fails that check is removed, and the failure is shown on the Backups page.

| Kind | Taken | Deleted |
|---|---|---|
| Nightly | every night at 03:00 in the container's `TZ` (change it on the Backups page) | by retention: the newest of each of the last 7 days and the newest of each of the last 4 weeks are kept |
| Manual | "Back up now", or `liner-doctor backup` | only when you delete it |
| Before update | by the app, before it applies database updates | after a successful update, keeping the newest 5 (`LINER_PREMIGRATE_BACKUP_KEEP`) |
| Before restore | by `liner-doctor restore --in-place` | only when you delete it |

Files are named `liner-<UTC time>[-<kind>].pgdump`. The `liner-` prefix is the project's old name, kept so older dumps sort with new ones. Each dump has a small `.json` file next to it that records its kind and the check. The schedule and retention are saved in the same folder as `backup-settings.json`, so restoring an older database never brings back older settings.

Defaults for a fresh install can be set with environment variables on the app: `BACKUP_NIGHTLY=off`, `BACKUP_HOUR` (0–23), `BACKUP_KEEP_DAILY` (1–90), `BACKUP_KEEP_WEEKLY` (0–52). Once settings are saved on the Backups page, the saved values win. `BACKUP_DIR` (or the older `LINER_BACKUP_DIR`) picks the folder; the compose files set it to `/backups`.

### Take a backup by hand

```sh
docker compose exec app node packages/doctor/dist/cli.js backup
```

Dumps land in `/backups` inside the app container. `--keep N` keeps only the newest N manual dumps (nightly, before-update and before-restore dumps are never touched), `--out DIR` writes somewhere else, `--json` prints the result as JSON.

Older versions wrote these dumps to `/cache/backups`. If a copy job or timer reads that folder, point it at `/backups` (the `backups` volume, or `TAGAVE_BACKUP_DIR`).

### Copy backups somewhere else

A backup on the same disk as the database does not survive that disk. Copy the folder off the computer regularly:

```sh
docker compose cp app:/backups ./tagave-backups
```

Or set `TAGAVE_BACKUP_DIR=/path/on/host` in `.env` and run `docker compose up -d`. The app then writes straight to that folder, and any sync or backup tool on the host (rclone, restic, a NAS sync app) can pick it up from there. Dumps already in the old volume stay there until you copy them over.

Keep `APP_SECRET` from `.env` in a password manager too. A database restored without it loses only the saved Discogs and AcoustID keys, which you then enter again.

### Restore a backup

`liner-doctor restore` replaces the whole database with a dump. It refuses to run while the app or a worker is connected, so stop them first and run it from a one-off container:

```sh
docker compose stop app worker-identify worker-files
docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore liner-<time>.pgdump --yes
docker compose up -d
```

A bare file name is looked up in the backups folder; a path works too. Without `--yes` the command only says what it would do. On a split install, stop the file worker on the other computer as well.

By default the dump is restored into a new database next to the current one. Once that has worked, the current database is renamed to `<name>_pre_restore_<time>` and the restored one takes its name. To go back, stop the app and swap the names back. Once you are happy, drop the old one:

```sh
docker compose exec postgres dropdb -U liner liner_pre_restore_<time>
```

Options:

- `--in-place` restores into the existing database instead, for a database user that may not create databases. A pre-restore backup is written first, and if the restore fails that backup is put back.
- `--force` restores even though the app or workers are connected. Their connections are closed.
- `--json` prints the result as JSON.

The restore does not run migrations. The app applies any the dump is missing when it starts.

On an installer install, see [Restore](#restore) for the same through the database container.

`install-tagave.sh update` takes its own backup before every update. Run `backup` before any other change you may want to undo, and put it on a nightly timer once you rely on the catalog.

## What happens when you update

When the app starts, it updates the database to match its version (migrations). In order:

1. **One at a time.** The app holds a database lock for the whole update. A second app that starts at the same moment waits ("another tagave process is migrating the database"), then finds nothing left to do.
2. **Never onto a newer database.** If a newer version of tagave has already updated the database, an older app refuses to start. Update the app, or roll back as below.
3. **Backup first.** If an existing database has updates to apply, the app writes `liner-<time>-pre-migration.pgdump` into `/backups` (listed under "Before update" in Settings › Backups), checks it with `pg_restore --list`, and records it. If the backup fails, the app does not touch the database and exits with a message starting `Not migrating:` that says why (usually a full disk, a folder it cannot write, a missing `pg_dump`, or a `/backups` that is not a mounted volume). A new, empty database needs no backup.
4. **Then the migrations**, each in its own transaction. Only when all of them have applied does the app delete older pre-update backups, keeping the newest 5 (`LINER_PREMIGRATE_BACKUP_KEEP`).

If a migration fails, the app exits and Docker restarts it. The database now has some of the update's migrations and not others. On the restart the app does not take a new backup, because that backup would hold the half-updated database. It keeps the first backup of this update as the rollback point (the log says "keeping its backup") and deletes nothing.

Before you update from a version without automatic backups, run the installer again (or replace `compose.yml` with the current one). The old file has no `/backups` volume. Settings › System shows "not a mounted volume" when that is the case.

The workers wait for the app: in the Compose files they start only once the app is healthy. A worker that is newer than the database waits until the app has updated it (up to `LINER_SCHEMA_WAIT_SECONDS`, 15 minutes by default, then it exits and Compose restarts it). A worker that is older than the database refuses to start, and a running worker stops when the app updates the database under it; its log says `will not run:` and which version it needs. On a split install, update the app computer first, then the music computer.

The status page (Settings › System) and `liner-doctor doctor` show this as two checks: **Database schema** (pending updates, or a database newer than this build) and **Backups before updates** (whether the next backup can be written, and where the last one is).

Overrides, for when you know why you need them:

| Setting | Effect |
|---|---|
| `LINER_SKIP_PREMIGRATE_BACKUP=1` | Update without the backup. The status page warns afterwards. With the installer, set `TAGAVE_SKIP_PREMIGRATE_BACKUP=1` in `.env`. |
| `LINER_ALLOW_SCHEMA_SKEW=1` | Let an app or worker run on a database a newer version updated. With the installer: `TAGAVE_ALLOW_SCHEMA_SKEW=1`. |
| `LINER_BACKUP_DIR` | Where the app writes backups inside its container (default `/backups`). |
| `LINER_BACKUP_REQUIRE_MOUNT=0` | Let the app back up into a folder that is not a mounted volume. The app image sets it to `1`. |
| `LINER_PREMIGRATE_BACKUP_KEEP` | How many pre-update backups to keep (default 5). With the installer: `TAGAVE_PREMIGRATE_BACKUP_KEEP`. |

Outside Docker (a source checkout), the app needs `pg_dump` and `pg_restore` of the same major version as the server on its `PATH` (or `PG_DUMP` and `PG_RESTORE` pointing at them) before it will apply an update. On a throwaway development database you can set `LINER_SKIP_PREMIGRATE_BACKUP=1` instead.

### Roll back an update

Migrations only go forward, so going back means restoring the backup the update took:

1. Stop everything: `docker compose down` (the volumes stay).
2. Set `TAGAVE_VERSION` in `.env` back to the version you had.
3. Start only the database: `docker compose up -d postgres`.
4. Find the backup taken before the update you are undoing. It is the **first** backup that update took, which is not always the newest file. The app log shows it ("backup written ..."), and so does the database's record:
   ```sh
   docker compose exec -T postgres psql -U liner liner -c \
     "select created_at, path, from_version, to_version from _migration_backups order by id desc limit 5"
   ```
   Use the row whose `to_version` is the version you are leaving and whose `from_version` is the version you are going back to.
   Settings › Backups lists the same file under "Before update". Restore it as in [Restore a backup](#restore-a-backup):
   ```sh
   docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore liner-<time>-pre-migration.pgdump --yes
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

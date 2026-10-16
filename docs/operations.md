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
2. Copies `.env`, the compose files and a verified `pg_dump` of the database to `backups/pre-update-<old version>-<UTC time>/` in the install folder. The dump is taken by the database container and read back with `pg_restore --list` before anything changes. The dumps of the newest 3 such folders are kept and older ones deleted; every folder keeps its `.env` and compose copies.
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

With the player on, when the update moved it to another Navidrome version, the update copied Navidrome's data to `/data/snapshots/pre-update` inside the `player-data` volume before the new version started. The printed roll back then also stops `player` and puts that copy back, before `docker compose pull && docker compose up -d`:

```sh
docker compose stop player
docker compose run --rm --no-deps -T --entrypoint sh player -c 'mv /data/navidrome /data/snapshots/rolled-back-$(date +%Y%m%d-%H%M%S) && cp -a /data/snapshots/pre-update /data/navidrome'
```

The folder the newer Navidrome changed stays in `/data/snapshots/rolled-back-…`. When the Navidrome version did not change, the player's data needs nothing restored, and `update` says so. The in-app updater does the same on its own when it rolls back.

If the update failed before the new app started, the database was not touched: copying the files back and running `docker compose pull && docker compose up -d` is enough, and `update` says so.

On a split install, roll the music computer back too: copy its saved `.env` back from its own `backups/pre-update-…` folder, then `docker compose pull && docker compose up -d`. Or run `./install-tagave.sh update` there once the app computer is back; it follows the app's version.

Anything the app did between the update and the roll back (new scans, edits, accepted matches) is lost with the restore. Scans can be run again.

**From 0.9 back to 0.8.** Always restore the database, as above; never start 0.8 on a database that 0.9 migrated: 0.8 knows only owners and viewers, and reads an editor or a listener as an owner. People invited after the update are gone with the restore. With the player on, the Navidrome accounts 0.9 made for each person stay in Navidrome unless its data was restored too; a phone app signed in with one of them keeps working. Remove them in Navidrome (Settings › Users) if they should not.

## Restore

To restore any dump (one from `update`, or one from the `backup` command below) into an installer install:

1. Get the dump onto the host. `update` dumps are already in `backups/`. A `backup` dump lives in the cache volume:
   ```sh
   docker compose cp app:/cache/backups/tagave-<timestamp>.pgdump ./backups/
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

## A page that freezes

The web app can record what keeps the browser busy, so a hang can be looked
into afterwards. It is off by default. To switch it on, open the browser's
developer console on the tagave tab and run:

```js
localStorage.setItem('tagave:diagnostics', '1'); location.reload()
```

From then on every moment the page is busy for 200 ms or more is recorded
with the page, how long it took and what ran; a freeze of a second or more is
also shown as a warning in the console. The record survives a reload and
never leaves the browser. When it happens again, run this in the console to
copy the report, and paste it into an issue:

```js
copy(JSON.stringify(tagaveDiagnostics()))
```

To switch it off: `localStorage.removeItem('tagave:diagnostics')`.

## Artist years after updating to 0.7.6

Before 0.7.6 no artist got its years (formed, split up, born) from
MusicBrainz: the lookup read the dates from the wrong place. Artists fetched
from now on get them. For the artists fetched before, run the backfill once
on the identify worker. It fetches each artist that has a MusicBrainz id and
no years again, about one a second, and can be run again safely: an artist
that has its years is skipped.

```sh
# how many artists it would fetch
docker compose exec worker-identify node packages/worker/dist/backfillArtistDates.js --dry-run
# fetch them (add --limit 500 to do it in batches)
docker compose exec worker-identify node packages/worker/dist/backfillArtistDates.js
```

It prints how many artists have years now, how many have none on
MusicBrainz, and any that failed (run it again later for those). Artists you
open in the app also get their years when their details are next refreshed.

## Disk space

A full disk stops Postgres, and with it the app. Updates are the usual cause: new images and backups land on top of whatever Docker has kept.

### What grows

- **Images:** each release brings new app, worker and updater images, about 3 GB together. Updates remove the older ones (see Old images); images from before that, and images you built yourself, stay.
- **Backups:** each dump is about the size of the database without its indexes. Nightly backups keep 7 daily and 4 weekly ones (Settings › Backups). Before-update dumps keep the newest 3 (at least 2). Manual dumps stay until you delete them, unless you set a number; pre-restore dumps stay until you delete them. Each kind has its own number on the Backups page.
- **Cache:** cover thumbnails and converted audio, in the `cache` volume. It grows with the library.
- **Build cache:** Docker keeps the layers of every image built on the computer. A source install that builds its own images collects gigabytes here.
- **Logs:** each container keeps at most three 10 MB log files (`docker-compose.prod.yml`). Containers started outside compose have no limit.
- **Database:** grows with the library and with finished tag changes (Settings › Storage can clean those up).

### How to check

- `tagave-doctor` has a Disk space check. It measures the backups folder, the cache folder and, when Postgres runs on the same computer, its data folder. It warns at 85 % used and fails at 95 %; `TAGAVE_DISK_WARN_PCT` and `TAGAVE_DISK_FAIL_PCT` in `.env` change that. Settings › System status shows the same check. `/api/v1/health` is public, so it says only ok, warn or error.
- In Docker the doctor cannot see Postgres's volume, and says so. Docker volumes usually share one disk, so the backups and cache numbers are a good guide; `df -h` on the host is the answer.
- Settings › Storage shows the free space of each disk, and what tagave itself takes. The owner sees a note on every page while a disk is past 85 %.
- On the host, `df -h` shows what is free and `docker system df` shows what images, containers, volumes and the build cache take.

### Safe to delete

- Dangling images: `docker image prune -f` removes images no tag names and no container uses.
- The build cache: `docker builder prune -f`. tagave never needs it to run.
- tagave images older than the previous release. Keep the one that runs and the one before it, for a roll back (see Old images).
- Old backups beyond retention, from Settings › Backups. Keep the newest, and copy anything you want to keep somewhere else first.

Never delete Docker volumes, and never prune them (`docker system prune --volumes`, `docker compose down -v` and the like). `pgdata` is the database; `backups` and `cache` go with it.

### Free space before updates

Before the in-app updater pulls anything, it works out what the update will write and checks each filesystem it writes to:

- **Docker's data** (`docker info --format '{{.DockerRootDir}}'`, usually `/var/lib/docker`): the new images, unpacked (about 2.5 × their download size).
- **The backups folder** (`/backups` in the app container): two dumps, the updater's own and the one the new app takes before it migrates. A dump is counted at the size of the newest one there, or, when there is none yet, at the database's size without its indexes.

When the backups are a volume (the default), both loads are on Docker's filesystem. A backups folder that reports the same size or the same free space as Docker's counts as the same disk; a host folder (`TAGAVE_BACKUP_DIR`) with other numbers counts as another disk; when it cannot tell, the backups are counted on both. The rule is:

```
needed = (images unpacked + 2 × backup) × 1.2 + 3 GB
```

The 3 GB is what is left free once the update has written everything: Postgres and the logs need room to run. `TAGAVE_UPDATER_MIN_FREE_MB` in `.env` changes it (default 3072). A backups folder on another disk (`TAGAVE_BACKUP_DIR`) is checked on its own, with 512 MB left free. Image sizes come from the registry; layers the running images already have are not counted. When the registry does not answer within 30 s or a measurement is out of reach, the updater counts 1 GB per image and 2 GB per backup, and the log says so.

If the space is not there, the update stops before it changes anything. The page says which filesystem is short, how much is free, how much the update needs, and what to delete. The check runs once more right before the backup, after the images came down.

Safe to delete:

```sh
docker builder prune      # build cache; never needed to run tagave
docker image prune        # images no container uses and no tag names
docker image ls --filter 'reference=*/tagave-*'   # then docker image rm the versions you no longer run (see Old images)
```

Old backups go from Settings › Backups (keep the newest). `df -h` shows what is free; `docker system df` shows what Docker keeps.

### Old images

Each release brings new app, worker and updater images, about 3 GB together. After an update succeeds, Settings › Updates and `install-tagave.sh update` remove the older ones and say in the update's log (or the installer's output) what went and how much space Docker counts for it. They keep:

- the images of the version that runs now, and of the version you updated from, so a roll back needs no download;
- any image a container uses, running or stopped;
- tags that are not plain release numbers (`latest`, `edge`, pre-releases such as `0.9.0-rc.1`), and images of any other repository.

Only `<registry>/tagave-app`, `tagave-worker` and `tagave-updater` are looked at (the registry is `TAGAVE_REGISTRY` in `.env`, `ghcr.io/xooxoxxo` by default), and of the player only the exact Navidrome image it ran before, when the update moved it to another version (other Navidrome tags on the computer may not be tagave's, so they stay; a roll back downloads the old one again). Nothing is pruned: volumes, the build cache and other images are left alone. A removal that fails is a warning; the update itself still counts as done.

To free space from releases before this one by hand, list the images and remove the old tags by name:

```sh
docker image ls | grep -E 'tagave-(app|worker|updater)'
docker image rm ghcr.io/xooxoxxo/tagave-app:0.7.0 ghcr.io/xooxoxxo/tagave-worker:0.7.0 ghcr.io/xooxoxxo/tagave-updater:0.7.0
```

### Recommended Docker settings

Let Docker clear its build cache by itself. Add this to `/etc/docker/daemon.json` (merge it with what is there), then restart Docker with `sudo systemctl restart docker`. The restart stops every container for a moment.

```json
{"builder":{"gc":{"enabled":true,"defaultKeepStorage":"10GB"}}}
```

Remove unused images and old build cache once a week. For example, with `sudo crontab -e`:

```sh
0 4 * * 0 docker image prune -f && docker builder prune -f --filter until=72h
```

Neither touches volumes or the images of running containers.

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
| Manual | "Back up now", or `tagave-doctor backup` | only when you delete it, or after the next manual backup when you set "keep the newest N" on the Backups page |
| Before update | by the app, before it applies database updates, and by the updater (`tagave-doctor backup --kind before-update`) | after a successful update, keeping the newest 3 (2–50 on the Backups page). An install that kept the earlier default of 5 keeps 5 until you pick a number |
| Before restore | by `tagave-doctor restore --in-place` | only when you delete it |

Files are named `tagave-<UTC time>[-<kind>].pgdump`. Releases before 0.9 named them `liner-<UTC time>[-<kind>].pgdump` (the project's old name); those stay listed, restorable and pruned with the new ones, sorted by time. Each dump has a small `.json` file next to it that records its kind and the check. The schedule and retention are saved in the same folder as `backup-settings.json`, so restoring an older database never brings back older settings. Lowering a number deletes nothing when you save it: the older backups of that kind go at its next run, and the Backups page lists which ones and how much space that frees. The newest backup of a kind is never deleted, and only files this app named are.

Defaults for a fresh install can be set with environment variables on the app: `BACKUP_NIGHTLY=off`, `BACKUP_HOUR` (0–23), `BACKUP_KEEP_DAILY` (1–90), `BACKUP_KEEP_WEEKLY` (0–52), `TAGAVE_PREMIGRATE_BACKUP_KEEP` (before update, 2–50). Once settings are saved on the Backups page, the saved values win. `BACKUP_DIR` (or the older `BACKUP_DIR`) picks the folder; the compose files set it to `/backups`.

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

`tagave-doctor restore` replaces the whole database with a dump. It refuses to run while the app or a worker is connected, so stop them first and run it from a one-off container:

```sh
docker compose stop app worker-identify worker-files
docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore tagave-<time>.pgdump --yes
docker compose up -d
```

A bare file name is looked up in the backups folder; a path works too. Without `--yes` the command only says what it would do. On a split install, stop the file worker on the other computer as well.

By default the dump is restored into a new database next to the current one. Once that has worked, the current database is renamed to `<name>_pre_restore_<time>` and the restored one takes its name. To go back, stop the app and swap the names back. Once you are happy, drop the old one:

```sh
docker compose exec postgres sh -c 'dropdb -U "$POSTGRES_USER" "${POSTGRES_DB}_pre_restore_<time>"'
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
3. **Backup first.** If an existing database has updates to apply, the app writes `tagave-<time>-pre-migration.pgdump` into `/backups` (listed under "Before update" in Settings › Backups), checks it with `pg_restore --list`, and records it. If the backup fails, the app does not touch the database and exits with a message starting `Not migrating:` that says why (usually a full disk, a folder it cannot write, a missing `pg_dump`, or a `/backups` that is not a mounted volume). A new, empty database needs no backup.
4. **Then the migrations**, each in its own transaction. Only when all of them have applied does the app delete older pre-update backups, keeping the newest 3, or the number saved on the Backups page.

If a migration fails, the app exits and Docker restarts it. The database now has some of the update's migrations and not others. On the restart the app does not take a new backup, because that backup would hold the half-updated database. It keeps the first backup of this update as the rollback point (the log says "keeping its backup") and deletes nothing.

Before you update from a version without automatic backups, run the installer again (or replace `compose.yml` with the current one). The old file has no `/backups` volume. Settings › System shows "not a mounted volume" when that is the case.

The workers wait for the app: in the Compose files they start only once the app is healthy. A worker that is newer than the database waits until the app has updated it (up to `TAGAVE_SCHEMA_WAIT_SECONDS`, 15 minutes by default, then it exits and Compose restarts it). A worker that is older than the database refuses to start, and a running worker stops when the app updates the database under it; its log says `will not run:` and which version it needs. On a split install, update the app computer first, then the music computer.

The status page (Settings › System) and `tagave-doctor doctor` show this as two checks: **Database schema** (pending updates, or a database newer than this build) and **Backups before updates** (whether the next backup can be written, and where the last one is).

Overrides, for when you know why you need them:

| Setting | Effect |
|---|---|
| `TAGAVE_SKIP_PREMIGRATE_BACKUP=1` | Update without the backup. The status page warns afterwards. |
| `TAGAVE_ALLOW_SCHEMA_SKEW=1` | Let an app or worker run on a database a newer version updated. |
| `BACKUP_DIR` | Where the app writes backups inside its container (default `/backups`). |
| `TAGAVE_BACKUP_REQUIRE_MOUNT=0` | Let the app back up into a folder that is not a mounted volume. The app image sets it to `1`. |
| `TAGAVE_PREMIGRATE_BACKUP_KEEP` | How many pre-update backups to keep until a number is saved on the Backups page (default 3, 2–50). When it is unset and the backups folder already has before-update backups from an earlier release, the app saves 5, that release's default, once. |

With the installer, set the `TAGAVE_*` ones in `.env`.

Outside Docker (a source checkout), the app needs `pg_dump` and `pg_restore` of the same major version as the server on its `PATH` (or `PG_DUMP` and `PG_RESTORE` pointing at them) before it will apply an update. On a throwaway development database you can set `TAGAVE_SKIP_PREMIGRATE_BACKUP=1` instead.

### Roll back an update

Migrations only go forward, so going back means restoring the backup the update took:

1. Stop everything: `docker compose down` (the volumes stay).
2. Set `TAGAVE_VERSION` in `.env` back to the version you had.
3. Start only the database: `docker compose up -d postgres`.
4. Find the backup taken before the update you are undoing. It is the **first** backup that update took, which is not always the newest file. The app log shows it ("backup written ..."), and so does the database's record:
   ```sh
   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c \
     "select created_at, path, from_version, to_version from _migration_backups order by id desc limit 5"'
   ```
   Use the row whose `to_version` is the version you are leaving and whose `from_version` is the version you are going back to.
   Settings › Backups lists the same file under "Before update". Restore it as in [Restore a backup](#restore-a-backup):
   ```sh
   docker compose run --rm --no-deps app node packages/doctor/dist/cli.js restore tagave-<time>-pre-migration.pgdump --yes
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

## Names from before 0.9

tagave was called liner before 0.9. Some names still carried it; 0.9 renamed them, and an install from before keeps working:

- **Settings** named `LINER_*` are `TAGAVE_*` now (`LINER_VERSION`, the version a build reports, is `TAGAVE_BUILD_VERSION`, since `TAGAVE_VERSION` is the image tag in `.env`). The old names still work until 0.10, with a note in the log. `install-tagave.sh update` (and a re-run, `enable-*` and `disable-*`) and the in-app updater rename them in `.env`, keeping the values and a private copy of the old file (`.env.bak.*` from the installer, `.env.bak` from the updater).
- **The database** keeps the user and name it was created with. An install from before 0.9 has `liner`, recorded in `.env` as `POSTGRES_USER` and `POSTGRES_DB`; new installs use `tagave`. Nothing renames an existing database.
- **Backups** are written as `tagave-<time>…pgdump`. Older `liner-<time>…pgdump` files stay in the list, sorted by time with the new ones, and are restored and pruned the same way.
- **The command** is `tagave-doctor`. `liner-doctor` still runs it until 0.10 and says so.

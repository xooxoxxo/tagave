# Operations

This page covers the health check, backups, and the cutover from external workers to containers. Return here when you need to verify the system is running, take a backup before an upgrade, or move workers into the Compose stack.

## Health check

Verify all systems are configured:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js doctor
```

Add `--expect-workers 0` while no worker runs yet. Or on a worker host: `pnpm doctor`.

## Where data lives

- **Database:** `pgdata` volume
- **Backups:** `backups` volume, mounted at `/backups` in the app container, or a folder on the host when `TAGAVE_BACKUP_DIR` is set in `.env`
- **Cache:** `cache` volume (thumbnails, converted audio). The cache is not a backup location.

The commands below are for an install made with the installer: run them in its folder (`~/tagave` unless you chose another). For a source install, add `-f docker-compose.prod.yml` after `docker compose`.

## Backups

The app backs the database up every night and keeps a set of recent dumps. It does not yet take one on its own before an update, so take one by hand ("Back up now") before you update. Settings › Backups lists them, takes one on demand, downloads or deletes one, and changes the schedule and how many are kept.

Every backup is a custom-format `pg_dump`, read back in full with `pg_restore --list` before it counts as written. A dump that fails that check is removed, and the failure is shown on the Backups page.

| Kind | Taken | Deleted |
|---|---|---|
| Nightly | every night at 03:00 in the container's `TZ` (change it on the Backups page) | by retention: the newest of each of the last 7 days and the newest of each of the last 4 weeks are kept |
| Manual | "Back up now", or `liner-doctor backup` | only when you delete it |
| Before update | not taken automatically yet: files named `liner-<time>-pre-migration.pgdump` show up under this kind | only when you delete it |
| Before restore | by `liner-doctor restore --in-place` | only when you delete it |

Files are named `liner-<UTC time>[-<kind>].pgdump`. The `liner-` prefix is the project's old name, kept so older dumps sort with new ones. Each dump has a small `.json` file next to it that records its kind and the check. The schedule and retention are saved in the same folder as `backup-settings.json`, so restoring an older database never brings back older settings.

Defaults for a fresh install can be set with environment variables on the app: `BACKUP_NIGHTLY=off`, `BACKUP_HOUR` (0–23), `BACKUP_KEEP_DAILY` (1–90), `BACKUP_KEEP_WEEKLY` (0–52). Once settings are saved on the Backups page, the saved values win. `BACKUP_DIR` picks the folder; the compose files set it to `/backups`.

### Take a backup by hand

```sh
docker compose exec app node packages/doctor/dist/cli.js backup
```

`--keep N` keeps only the newest N manual dumps (nightly, before-update and before-restore dumps are never touched), `--out DIR` writes somewhere else, `--json` prints the result as JSON.

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

### Roll back an update

Database changes only go forward, so an older version cannot run on a database a newer one has changed. To go back:

1. On the Backups page, find the backup you took before the update, or the newest nightly one from before it.
2. Set the previous version in `.env` (`TAGAVE_VERSION=<old version>`) and run `docker compose pull`.
3. Restore that backup as above, then run `docker compose up -d`.

From source, check out the previous version and rebuild instead of step 2.

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

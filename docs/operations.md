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
- **Cache:** `cache` volume (thumbnails, converted audio, database dumps)

## Taking a backup

Take a verified dump of the database using custom `pg_dump` format, checked with `pg_restore --list` before the command reports success, and older dumps pruned to the newest 14:

```sh
docker compose -f docker-compose.prod.yml exec app node packages/doctor/dist/cli.js backup --keep 14
```

Dumps land in `/cache/backups/liner-<timestamp>.pgdump` inside the app container.
The `liner-` prefix is the old project name and is still what the code writes;
it is a filename, not a display string, so it has deliberately not been renamed. Use `--out DIR` or set `LINER_BACKUP_DIR` to change the location.

Copy dumps off the host. The cache volume is not a backup location:

```sh
docker compose -f docker-compose.prod.yml cp app:/cache/backups ./backups
```

Restore into an empty database:

```sh
pg_restore --no-owner --dbname=postgres://liner:…@localhost:5432/liner ./backups/liner-<timestamp>.pgdump
```

Run `backup` before every upgrade, and put it on a nightly timer once you rely on the catalog.

## Moving workers into containers

If you started with a worker on another machine and want the `workers` profile to take over, follow this procedure once. Nothing in the database changes as long as the library ends up at the same path inside the container as the scan root you registered. If paths differ, edit the scan root's path in Settings after step 3.

### Prerequisites

- The Compose host can read the library at the path you set as `MUSIC_DIR` in `.env` (local disk, or NFS/SMB export).
- `APP_SECRET` in `.env` is the value the app already runs with. Workers open the same sealed credentials.

### Cutover

1. Build the worker images while the old workers keep running. Pass the same build args that `scripts/deploy.sh` passes for the app (they are what Settings › Updates and the doctor `Build Versions` check compare):
   ```sh
   GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \
   docker compose -f docker-compose.prod.yml --profile workers build
   ```

2. Stop the old workers on their host. `scripts/deploy.sh` tracks them in `~/liner-worker.pid` and `~/liner-identify.pid`; under systemd, use `systemctl stop`. A worker finishes its current job on `SIGTERM`; give it up to 30 seconds, then `kill -9` one that ignores it. A ghost of the old build keeps a database connection and shows up in `Build Versions` as a lagging sha.

3. Start the containers:
   ```sh
   docker compose -f docker-compose.prod.yml --profile workers up -d
   ```

4. Verify. The first heartbeat lands about 30 seconds after boot. `Worker Heartbeat` and `Build Versions` must both pass, and Settings › Updates must list both workers at the app's sha:
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

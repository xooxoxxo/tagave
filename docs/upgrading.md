# Upgrading Guide

This guide covers updating tagave to a new version.

## Before You Upgrade

1. **Back up your database** — always, every time:
   ```bash
   docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump
   ```

2. **Read release notes** — check [CHANGELOG.md](../CHANGELOG.md) for breaking changes

3. **Plan for downtime** — minor updates take 20–30 seconds; major updates may take 2–5 minutes

## Minor Update (e.g., v1.0.0 → v1.0.1)

No database schema changes. Follow this procedure:

```bash
# 1. Back up (always)
docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump

# 2. Update image tag in .env (optional; docker compose pull uses latest)
# echo "IMAGE_TAG=v1.0.1" >> .env

# 3. Pull latest image and restart
docker compose pull
docker compose up -d

# 4. Verify (takes ~30 seconds)
docker compose ps
curl http://localhost:3100/api/system/health
```

The app will restart briefly; the web interface will be unavailable for 20–30 seconds.

## Major Update (e.g., v1.0.0 → v2.0.0)

May include database migrations. Follow this procedure:

```bash
# 1. Back up (always)
docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump

# 2. Read release notes for breaking changes
# Check: CHANGELOG.md for migration instructions

# 3. Pull latest image
docker compose pull

# 4. Restart services (migrations run automatically on startup)
docker compose up -d

# 5. Wait for migrations to complete (check logs)
docker compose logs -f api | grep -i migration

# 6. Verify all services are healthy
docker compose ps
curl http://localhost:3100/api/system/health

# 7. Open web UI and verify
# http://localhost:3100/settings/system-status
```

Migrations run during startup and may take 2–5 minutes. The API will be unavailable until migrations complete.

## Split Topology (Workers on Separate Host)

When workers run on a different host:

### Option A: Update App Host First (Recommended)

```bash
# On app host (Host A)
docker compose exec postgres pg_dump -U liner > backup-$(date +%s).pgdump
docker compose pull
docker compose up -d

# Wait for app to be healthy
sleep 30
curl http://localhost:3100/api/system/health

# On worker host (Host B)
docker compose pull
docker compose up -d

# Wait for workers to reconnect
docker compose logs -f worker-file | head -20
```

During this time:
- App is briefly offline while restarting (~30s)
- Existing scans in the queue will restart when workers reconnect
- No data is lost

### Option B: Update Both Simultaneously

```bash
# On app host (Host A)
docker compose pull

# On worker host (Host B)
docker compose pull

# On app host: restart
docker compose up -d

# On worker host: restart
docker compose up -d
```

This is slightly faster but leaves the system offline a few seconds longer.

## Rollback (If Update Fails)

If an update breaks something:

```bash
# 1. Stop services
docker compose down

# 2. Restore from backup
docker compose up -d postgres
sleep 10
docker compose exec postgres psql -U liner < backup-$(date +%s).pgdump

# 3. Start everything else
docker compose up -d

# 4. Verify
docker compose ps
curl http://localhost:3100/api/system/health
```

Note: Rollback resets the database to the time of backup. Any changes made after backup are lost.

## Manual Image Update

If using a custom image or tag:

```bash
# Update IMAGE_TAG or image name in docker-compose.yml or .env
echo "IMAGE_TAG=v2.0.0" >> .env

# Or edit docker-compose.yml directly and change:
# image: ghcr.io/xooxoxxo/tagave:v2.0.0

# Pull and restart
docker compose pull
docker compose up -d
```

## Troubleshooting Updates

### Migrations are slow

Large databases may take 5–15 minutes to migrate. This is normal.

```bash
# Monitor migration progress
docker compose logs -f api | grep -i migration
```

### Services fail to start after update

Check the logs:

```bash
docker compose logs api
docker compose logs postgres
docker compose logs worker-file
```

Common issues:
- Database schema mismatch (restore from backup and try again)
- Out of disk space (free up space and restart)
- Port already in use (check for conflicting services)

### Workers don't reconnect

After updating both app and workers:

```bash
# Restart workers
docker compose restart worker-file worker-identify

# Check they can reach the app
docker compose exec worker-file ping api

# Check logs
docker compose logs worker-file
```

### Disk space needed during migration

Major updates may temporarily require extra disk space while migrations run.

```bash
# Check available space
df -h /

# If space is low, clear old backups
rm -f backup-*.pgdump
```

## Automatic Updates (Future)

When tagave is deployed with automatic update support, the settings page will show:
- "Update available: vX.Y.Z"
- One-click update button (or cron-scheduled updates)

For now, updates are manual following the procedures above.

## Version History

See [CHANGELOG.md](../CHANGELOG.md) for version history and migration notes.

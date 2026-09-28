# Backup and Restore Guide

This guide covers backing up and restoring your tagave database and configuration.

## Why Back Up?

Your database contains:
- Album metadata (artist, title, release date, etc.)
- Your edits and corrections (tag plans, locked fields)
- Scan history and fingerprints
- External API credentials (MusicBrainz contact info, Discogs token)

The music files themselves are not in the database; they remain in your music library folder.

## Quick Backup

```bash
# Create a backup
docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump

# Verify the backup exists
ls -lh backup-*.pgdump
```

This creates a single compressed SQL file that can be restored later.

## Manual Backup Procedure

### Full Backup (Database + Configuration)

```bash
# Create a backup directory
mkdir -p backups
cd backups

# Dump the database
docker compose exec postgres pg_dump -U liner -Fc liner > db-backup-$(date +%Y%m%d-%H%M%S).pgdump

# Backup the .env file (contains secrets)
cp ../.env env-backup-$(date +%Y%m%d-%H%M%S)

# (Optional) Backup docker-compose.yml
cp ../docker-compose.yml docker-compose-$(date +%Y%m%d-%H%M%S).yml

# Verify
ls -lh
```

### Compressed Text Backup (Portable)

```bash
# Creates a plain SQL file (larger, but portable)
docker compose exec postgres pg_dump -U liner liner > backup-$(date +%Y%m%d).sql

# Or with gzip compression
docker compose exec postgres pg_dump -U liner liner | gzip > backup-$(date +%Y%m%d).sql.gz
```

## Automated Backups

### Using Cron (Linux/macOS)

Create a backup script:

```bash
# backup.sh
#!/bin/bash
BACKUP_DIR="$HOME/tagave-backups"
mkdir -p "$BACKUP_DIR"
cd /path/to/tagave
docker compose exec -T postgres pg_dump -U liner -Fc liner > "$BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S).pgdump"
# Keep only last 7 days
find "$BACKUP_DIR" -name "backup-*.pgdump" -mtime +7 -delete
```

Make it executable and add to crontab:

```bash
chmod +x backup.sh
crontab -e

# Add line (runs daily at 2 AM):
0 2 * * * /path/to/backup.sh
```

### Using Docker (Systemd Timer)

Create a systemd timer to run backups:

```bash
# /etc/systemd/system/tagave-backup.service
[Unit]
Description=Tagave Database Backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/path/to/tagave
ExecStart=/bin/bash -c 'docker compose exec -T postgres pg_dump -U liner -Fc liner > /backup/tagave-$(date +\%Y\%m\%d-\%H\%M\%S).pgdump'
User=root

# /etc/systemd/system/tagave-backup.timer
[Unit]
Description=Run Tagave Backup Daily
Requires=tagave-backup.service

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target

# Enable and start
sudo systemctl enable tagave-backup.timer
sudo systemctl start tagave-backup.timer
```

## 3-2-1 Backup Strategy

Best practice: **3 copies, 2 different media, 1 offsite**

```
Local backup (docker-compose exec ...)
  ↓
External drive (weekly copy)
  ↓
Cloud storage (monthly copy via rclone, S3, etc.)
```

Example with rclone (sync to cloud):

```bash
# Configure rclone for your cloud provider
rclone config

# Sync backups to cloud (e.g., S3)
rclone sync /path/to/backups s3:my-bucket/tagave-backups/ --delete-after
```

## Quick Restore

If you need to restore from a backup:

```bash
# 1. Stop services (optional, but safer)
docker compose stop api worker-file worker-identify

# 2. Restore from backup
docker compose exec postgres psql -U liner < backup-YYYYMMDD.sql

# Or if using .pgdump format:
docker compose exec postgres pg_restore -U liner -d liner backup-YYYYMMDD.pgdump

# 3. Restart services
docker compose start
```

## Full Restore Procedure

If you're restoring to a fresh installation:

```bash
# 1. Install tagave normally
bash -c "$(curl -fsSL ...install-tagave.sh)"

# 2. Wait for initial setup to complete
sleep 30

# 3. Stop services
docker compose down

# 4. Start only the database
docker compose up -d postgres
sleep 10

# 5. Drop the default database
docker compose exec postgres dropdb -U liner liner

# 6. Restore from backup
docker compose exec postgres psql -U liner < backup-file.sql

# 7. Start all services
docker compose up -d

# 8. Verify
docker compose ps
curl http://localhost:3100/api/system/health
```

## Backup Verification

Always verify your backup can be restored:

```bash
# Create a test restore container
docker compose exec postgres pg_restore -U liner --list backup-$(date +%s).pgdump

# Or restore to a test database
docker compose exec postgres psql -U liner -c "CREATE DATABASE liner_test"
docker compose exec postgres pg_restore -U liner -d liner_test backup-file.pgdump

# Verify test database
docker compose exec postgres psql -U liner -d liner_test -c "SELECT count(*) FROM albums"

# Clean up test database
docker compose exec postgres dropdb -U liner liner_test
```

## Backup Storage Location

Recommended locations:

| Location | Pros | Cons |
|----------|------|------|
| `./backups` (same host) | Easy, fast | Lost if host fails |
| External USB drive | Durable, portable | Manual copies |
| NAS (NFS mount) | Shared, large | Network dependency |
| Cloud (S3, B2, etc.) | Offsite, reliable | Requires credentials |

Example: Set up automated backup to external drive:

```bash
# Mount external drive
sudo mount /dev/sda1 /mnt/backup

# Add to cron backup script
BACKUP_DIR="/mnt/backup/tagave"
mkdir -p "$BACKUP_DIR"
docker compose exec -T postgres pg_dump -U liner -Fc liner > "$BACKUP_DIR/backup-$(date +%Y%m%d).pgdump"
```

## Disaster Recovery

If the entire system fails:

1. **Recreate the environment**: New server, install Docker, download tagave
2. **Restore from backup**: Follow "Full Restore Procedure" above
3. **Restore music files**: Restore from music backup or rescan
4. **Verify**: Check System Status page, scan a few albums

Typical recovery time: 30 minutes to 2 hours depending on database size.

## Configuration Backup (.env)

Your `.env` file contains secrets (APP_SECRET, database password). Back it up separately:

```bash
# Back up .env
cp .env env-backup-$(date +%s)
chmod 600 env-backup-*

# Store securely (not in git, not in cloud unencrypted)
# Consider: hardware key, password manager, encrypted cloud storage
```

Never commit `.env` to version control or share it in chat.

## See Also

- [Installation Guide](installation.md) — Setting up tagave
- [Upgrading Guide](upgrading.md) — Version updates
- [Troubleshooting](troubleshooting.md) — Common issues

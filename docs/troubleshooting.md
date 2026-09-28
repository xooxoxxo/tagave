# Troubleshooting Guide

This guide covers common issues and how to fix them.

## Setup Wizard Won't Load

**Symptoms**: Opening http://localhost:3100/setup shows a blank page or "could not connect"

**Diagnosis**:
```bash
# Check if containers are running
docker compose ps

# Check if API is responding
curl http://localhost:3100/api/system/health

# Check API logs for errors
docker compose logs api | tail -30
```

**Fixes**:

1. **Wait for startup** (first time):
   - Database migrations take 10-30 seconds on first run
   - Wait 30 seconds and refresh the page

2. **Database failed to initialize**:
   ```bash
   docker compose down
   docker compose up -d
   docker compose logs postgres
   ```

3. **Port 3100 already in use**:
   ```bash
   # Check what's using the port
   lsof -i :3100
   # Or change port in docker-compose.yml and restart
   docker compose up -d
   ```

4. **PostgreSQL won't start**:
   ```bash
   # Check postgres logs
   docker compose logs postgres
   # If data is corrupted, remove and restart:
   docker compose down -v
   docker compose up -d
   # Warning: this deletes all data; restore from backup if needed
   ```

## Workers Won't Connect

**Symptoms**: "Workers not responding" message in web UI, or workers stuck in "Pending" state

**Diagnosis**:
```bash
# Check if worker containers exist and are running
docker compose ps | grep worker

# Check worker logs
docker compose logs worker-file | tail -20
docker compose logs worker-identify | tail -20

# Test database connectivity
docker compose exec worker-file pg_isready -U liner
```

**Fixes**:

1. **Workers not running** (single-host):
   ```bash
   # Start them
   docker compose up -d worker-file worker-identify
   docker compose logs -f worker-file
   ```

2. **Workers on separate host** (split topology):
   ```bash
   # On worker host, check they're running
   ssh user@192.168.1.20 docker compose ps
   
   # Check database URL is correct
   ssh user@192.168.1.20 grep DATABASE_URL .env
   
   # Test connectivity from worker to app
   ssh user@192.168.1.20 pg_isready -h 192.168.1.10 -U liner
   ```

3. **Database connectivity issue**:
   ```bash
   # Check password is correct
   grep POSTGRES_PASSWORD .env
   
   # Test connection manually
   docker compose exec worker-file psql -h postgres -U liner -c "SELECT 1"
   ```

4. **Worker has no access to music**:
   ```bash
   # Check music directory exists
   ls /mnt/music
   
   # Check permissions
   ls -la /mnt/music | head -5
   
   # On split topology, check mount on worker host
   ssh user@192.168.1.20 mount | grep music
   ```

## Music Path Not Found

**Symptoms**: "Path not found" error when trying to add a scan root

**Diagnosis**:
```bash
# Check the path exists
ls -la /mnt/music

# Check it contains music files
find /mnt/music -name "*.mp3" | head -5

# Check permissions (worker needs read access)
docker compose exec worker-file ls /mnt/music
```

**Fixes**:

1. **Path doesn't exist**:
   ```bash
   # Create the directory
   mkdir -p /mnt/music
   
   # On split topology, create on worker host
   ssh user@192.168.1.20 mkdir -p /mnt/music
   ```

2. **NFS/SMB mount not connected**:
   ```bash
   # On single-host
   sudo mount -t nfs nas.local:/export/music /mnt/music
   
   # On split topology, mount on worker host
   ssh user@192.168.1.20 sudo mount -t nfs nas.local:/export/music /mnt/music
   
   # Verify
   ls /mnt/music
   ```

3. **Permission denied**:
   ```bash
   # Check worker can read files
   docker compose exec worker-file ls /mnt/music
   
   # If permission denied, check mount options:
   sudo umount /mnt/music
   sudo mount -t nfs nas.local:/export/music /mnt/music -o uid=1000,gid=1000
   ```

4. **Symbolic links or special characters**:
   ```bash
   # Resolve symlinks
   realpath /mnt/music
   
   # Use absolute path in setup wizard, not symlinks
   ```

## Database Is Full or Running Out of Space

**Symptoms**: Scan fails with "out of space", or disk usage is 90%+

**Diagnosis**:
```bash
# Check available space
df -h /

# Check database size
docker compose exec postgres du -sh /var/lib/postgresql/data

# Check cache size
du -sh ./cache

# Find large files
du -sh ./cache/* | sort -h | tail -10
```

**Fixes**:

1. **Clear cache**:
   ```bash
   # Back up first
   cp -r ./cache ./cache.bak
   
   # Clear thumbnails and temp files
   rm -rf ./cache/thumbnails/*
   rm -rf ./cache/temp/*
   
   # Restart services
   docker compose restart
   ```

2. **Shrink database** (remove old scans):
   ```bash
   # This requires SQL knowledge; backup first
   docker compose exec postgres psql -U liner -c "\
     DELETE FROM scan_history WHERE created_at < now() - interval '90 days';"
   ```

3. **Expand storage**:
   ```bash
   # Add external drive
   mount /dev/sda1 /mnt/large
   
   # Move cache to larger volume
   docker compose stop
   mv ./cache /mnt/large/cache
   mkdir ./cache
   docker compose start
   ```

4. **Check music library size**:
   ```bash
   du -sh /mnt/music
   # If over 500GB, may need to split library or use separate workers
   ```

## Scans Are Slow or Getting Stuck

**Symptoms**: Scans take hours, or progress bar hasn't moved in 30+ minutes

**Diagnosis**:
```bash
# Check worker CPU usage
docker compose stats worker-file --no-stream

# Check database query performance
docker compose exec postgres psql -U liner -c "\
  SELECT query, mean_exec_time FROM pg_stat_statements \
  ORDER BY mean_exec_time DESC LIMIT 5;"

# Check queue depth
docker compose logs worker-file | grep "queue depth" | tail -5
```

**Fixes**:

1. **Worker is overloaded**:
   ```bash
   # Allocate more CPU in docker-compose.yml:
   # services:
   #   worker-file:
   #     cpus: "2"  # increase from 1
   
   docker compose up -d --force-recreate
   ```

2. **Fingerprinting is slow** (acoustic analysis):
   ```bash
   # Check audio file count and quality
   find /mnt/music -name "*.mp3" | wc -l
   
   # Fingerprinting takes ~0.5-1s per track depending on hardware
   # Large libraries (50,000+ tracks) may take days
   ```

3. **Database is slow**:
   ```bash
   # Check if indices exist
   docker compose exec postgres psql -U liner -c "\
     SELECT indexname FROM pg_indexes WHERE schemaname = 'public';"
   
   # If missing, run migrations
   docker compose exec api node packages/db/dist/migrate.js
   ```

4. **Network is slow** (split topology):
   ```bash
   # Test latency
   ssh user@192.168.1.20 ping -c 3 192.168.1.10
   
   # If latency > 100ms, may need to optimize network or move workers closer
   ```

## Metadata Is Wrong or Missing

**Symptoms**: Albums matched incorrectly, missing artwork, or artist names are blank

**This is expected behavior for:**
- Obscure or self-released albums (no MusicBrainz entry)
- Misspelled tags in your files
- Multiple releases with same title

**Fixes**:

1. **Re-scan with correct metadata**:
   ```bash
   # Edit file tags manually or use another tool (Picard, etc.)
   # Then re-scan in tagave
   ```

2. **Link to MusicBrainz/Discogs manually**:
   - In the web UI, open the album
   - Click "Link to release" and search MusicBrainz/Discogs
   - Confirm and save

3. **Check external API limits**:
   - MusicBrainz: 1 req/s (we respect this)
   - Discogs: 25 req/min unauthenticated, 55 authenticated
   - If you get 429 (rate limit), wait 60s and try again

## Workers Restart Frequently

**Symptoms**: "Worker restarted" in logs repeatedly

**Diagnosis**:
```bash
# Check restart count
docker compose ps | grep worker

# Check logs for errors
docker compose logs --tail=50 worker-file
docker compose logs --tail=50 worker-identify
```

**Fixes**:

1. **Out of memory**:
   ```bash
   # Check memory usage
   docker compose stats --no-stream
   
   # Increase memory in docker-compose.yml:
   # services:
   #   worker-file:
   #     memory: "2g"
   
   docker compose up -d --force-recreate
   ```

2. **Database connection lost** (split topology):
   ```bash
   # Check database is reachable
   docker compose exec worker-file pg_isready -h 192.168.1.10 -U liner
   
   # Check password in .env
   grep DATABASE_URL .env
   ```

3. **Audio decoding error**:
   ```bash
   # Worker fails on corrupted audio file
   # Check file
   ffmpeg -v error -i /mnt/music/path/to/file.mp3
   
   # Skip or fix the file
   ```

## External APIs Not Working

**Symptoms**: MusicBrainz searches fail, Discogs won't connect

**Diagnosis**:
```bash
# Test MusicBrainz API
curl "https://musicbrainz.org/ws/2/release?query=beatles&fmt=json&limit=1"

# Check rate limit status
docker compose exec api curl "http://localhost:3000/api/system/health" | grep musicbrainz
```

**Fixes**:

1. **MusicBrainz rate limited**:
   ```bash
   # This is normal; wait 60 seconds
   # Or set a custom User-Agent in Settings
   ```

2. **Discogs token invalid or expired**:
   ```bash
   # In web UI: Settings → External APIs → Discogs
   # Get new token from discogs.com/settings/developers
   ```

3. **Network connectivity**:
   ```bash
   # Test from API container
   docker compose exec api curl https://musicbrainz.org/ws/2/release?fmt=json
   
   # If fails, check firewall/proxy allows outbound HTTPS
   ```

## Settings Page Shows Errors

**Symptoms**: Red warnings on System Status or Settings pages

**Diagnosis**:
```bash
# Get full system status
curl http://localhost:3100/api/system/health

# Check individual services
docker compose exec postgres pg_isready -U liner
docker compose exec api curl -f http://localhost:3000/_health
```

**Fixes**: See specific error messages on the Settings → System Status page

## Docker Issues

### "docker: command not found"
```bash
# Install Docker: https://docs.docker.com/engine/install/
# Or use system package manager:
sudo apt-get install docker.io docker-compose  # Ubuntu/Debian
sudo yum install docker docker-compose         # RHEL/CentOS
```

### "Permission denied ... docker.sock"
```bash
# Add your user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Or run with sudo
sudo docker compose up -d
```

### "Container exited with code 137" (out of memory)
```bash
# Increase Docker memory limit
# macOS/Windows: Docker Desktop settings
# Linux: increase system memory or allocate more to containers
```

## Need More Help?

1. **Check logs**:
   ```bash
   docker compose logs --tail=100 api
   docker compose logs --tail=100 worker-file
   docker compose logs --tail=100 postgres
   ```

2. **Run diagnostics**:
   ```bash
   docker compose exec api node packages/doctor/dist/cli.js doctor
   ```

3. **System status page**:
   - Open http://localhost:3100/settings/system-status
   - Shows health of all services with remediation

4. **Reach out**:
   - GitHub Issues: https://github.com/xooxoxxo/tagave/issues
   - Include: error message, `docker compose ps`, `docker compose logs --tail=50 api`

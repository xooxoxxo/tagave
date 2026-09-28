# Installation Guide

This guide covers installing tagave for single-host and split-topology setups.

## Prerequisites

- **Docker**: 20.10 or later (`docker --version`)
- **Docker Compose**: v2 (`docker compose version`)
- **2 GB RAM** available for containers
- **5 GB disk space** for the application and metadata
- **Network access** to your music library (local path, NFS mount, or SMB share)

## Quick Install

The easiest way to install tagave is with the automated installer:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
```

The installer will:
1. Check your prerequisites
2. Ask where your music library is located
3. Ask if workers should run on this host or a separate machine
4. Generate secrets and configuration files
5. Start the application

After installation, open your browser to the URL shown (typically `http://localhost:3100/setup`) and complete the setup wizard.

## Manual Installation

If the installer doesn't work for your environment, you can set up tagave manually.

### Step 1: Get the Files

```bash
# Clone or download the repository
git clone https://github.com/xooxoxxo/tagave.git
cd tagave
```

### Step 2: Configure Secrets

```bash
# Generate a secure APP_SECRET
APP_SECRET=$(openssl rand -hex 32)

# Create .env file with your secrets
cat > .env <<EOF
APP_SECRET=$APP_SECRET

# Set to your music library path (this host, or NFS/SMB mount)
MUSIC_DIR=/mnt/music
EOF
```

### Step 3: Prepare Music Directory

Create or mount your music library:

```bash
# Local path example
mkdir -p /mnt/music

# Or mount NFS
sudo mount -t nfs nas.local:/export/music /mnt/music

# Or mount SMB
sudo mount -t cifs //nas.local/music /mnt/music -o username=user,password=pass
```

Verify it's accessible:
```bash
ls /mnt/music
```

### Step 4: Start Services

```bash
# Start all services (API, database, workers)
docker compose up -d

# Wait for services to be healthy
docker compose exec postgres pg_isready -U liner
docker compose exec api curl -f http://localhost:3000/_health
```

### Step 5: Complete Setup

Open your browser to `http://localhost:3100/setup` and follow the wizard to:
1. Create an admin account
2. Confirm the music library path
3. Configure workers (same host or separate)
4. (Optional) Add external API tokens (MusicBrainz, Discogs, AcoustID)

## Single-Host Topology

All services run on one machine. This is the simplest setup and works well for:
- Developer laptops
- Small servers (NAS, home server)
- Single-user installations with <10,000 albums

**docker-compose.yml** (default) includes:
- API (web + API server)
- PostgreSQL database
- File worker (scans and fingerprints audio)
- Identify worker (matches against MusicBrainz/Discogs)

No additional configuration needed beyond setting `MUSIC_DIR`.

## Split Topology

Workers run on a separate host. This is useful for:
- Large libraries requiring significant compute power
- Shared NAS with dedicated worker machine
- Offloading CPU-intensive tagging to faster hardware

See [Split Topology Guide](split-topology.md) for detailed setup instructions.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `APP_SECRET` | Yes | — | Session signing and credential encryption |
| `MUSIC_DIR` | No | `/mnt/music` | Path to music library (for workers) |
| `PUBLIC_URL` | No | `http://localhost:3100` | External URL (for redirects, if behind proxy) |
| `ALLOW_INSECURE_HTTP` | No | `false` | Allow HTTP cookies (dev only) |
| `LOG_LEVEL` | No | `info` | Logging level: debug, info, warn, error |

For split topology, also set:
- `WORKER_HOST`: IP or hostname of worker machine
- `DATABASE_URL`: Connection string for workers to reach database

## Health Checks

After startup, verify all services are healthy:

```bash
# Check service status
docker compose ps

# Check database
docker compose exec postgres pg_isready -U liner

# Check API
curl http://localhost:3100/api/system/health

# Check workers
docker compose logs worker-file | tail -20
docker compose logs worker-identify | tail -20
```

If any service is unhealthy, check the logs:

```bash
docker compose logs api
docker compose logs worker-file
docker compose logs postgres
```

## Ports

By default, tagave uses:
- **3100** (HTTP): Web interface and API
- **5432** (PostgreSQL): Database (not exposed to host by default)
- **6379** (Redis): Cache (optional, internal only)

If port 3100 is in use, you can change it in docker-compose.yml:

```yaml
services:
  api:
    ports:
      - "3200:3000"  # Change 3200 to your preferred port
```

Then access the UI at `http://localhost:3200`.

## Reverse Proxy (HTTPS)

To use tagave behind a reverse proxy (nginx, Traefik, etc.):

1. Set `PUBLIC_URL` to your external URL:
   ```bash
   echo "PUBLIC_URL=https://music.example.com" >> .env
   ```

2. Set `ALLOW_INSECURE_HTTP=true` to allow cookies over HTTP (the proxy handles HTTPS):
   ```bash
   echo "ALLOW_INSECURE_HTTP=true" >> .env
   ```

3. Configure your reverse proxy to forward requests to `http://localhost:3100`

4. Restart: `docker compose up -d`

## Troubleshooting

### Setup wizard won't load
- Check API is running: `docker compose ps api`
- Check logs: `docker compose logs api`
- Wait 10-15 seconds for database migrations to complete

### Workers won't start
- Check database connectivity: `docker compose logs worker-file`
- Verify `MUSIC_DIR` path exists: `ls -la /mnt/music`
- If using NFS/SMB, verify mount: `mount | grep music`

### Music path not found
- Verify the path in `.env` is correct and readable
- Check permissions: `ls -la /mnt/music`
- If using NFS/SMB mount, check it's mounted

### Database is full
- Check available space: `df -h /`
- Clear cache: `rm -rf ./cache/thumbnails/*`
- Back up and review library size: `du -sh /mnt/music`

See [Troubleshooting Guide](troubleshooting.md) for more common issues.

## Next Steps

After installation and setup:
1. Add scan roots in Settings → Music Library
2. Start a scan to identify your albums
3. Review and correct metadata in the Plans view
4. (Optional) Link your Discogs collection in Settings → External APIs

See [Features](features.md) for a detailed walkthrough of the interface.

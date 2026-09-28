# Split Topology Guide

This guide covers running tagave with workers on a separate host from the API and database.

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────┐
│ Host A (App Server)     │         │ Host B (Worker Machine)  │
├─────────────────────────┤         ├──────────────────────────┤
│ • API (port 3100)       │◄────────│ • File Worker            │
│ • Web UI                │         │ • Identify Worker        │
│ • PostgreSQL (5432)     │         │                          │
│ • Redis (cache)         │         │ Shared storage:          │
│                         │         │ • /mnt/music (NFS/SMB)   │
└─────────────────────────┘         └──────────────────────────┘

Network: Host B → Host A:5432 (TCP)
Storage: Both hosts access /mnt/music via NFS or SMB
```

## When to Use Split Topology

Use split topology if:
- Your music library is on a NAS, and you want dedicated compute for scanning
- You have a lightweight app server and a faster machine for CPU-intensive tagging
- You want to isolate database I/O from scanning CPU usage
- You're running on different hardware (e.g., ARM app server, x86_64 workers)

Don't use split topology if:
- Your library fits on one machine with adequate resources
- You want the simplest possible setup
- Network latency between hosts is high (>50ms to database)

## Network Setup

### Prerequisites

- Host A and Host B are on the same network and can reach each other
- Both hosts have Docker and Docker Compose v2
- You can SSH to the worker host to run commands
- Music is mounted on Host B at the same path as Host A (e.g., `/mnt/music`)

### Firewall Rules

Host A must allow Host B to reach PostgreSQL:

```bash
# On Host A (app server)
# Allow port 5432 from Host B's IP
sudo ufw allow from 192.168.1.20 to any port 5432  # Replace IP with your worker host

# Or allow all hosts (less secure)
sudo ufw allow 5432
```

PostgreSQL binds to `0.0.0.0:5432` by default (visible on all network interfaces).

### Test Connectivity

From Host B (worker), verify you can reach Host A:

```bash
# Test TCP connection to Host A database
nc -zv 192.168.1.10 5432  # Replace IP with your app host

# Or use pg_isready (requires postgres-client)
pg_isready -h 192.168.1.10 -U liner
```

## Installation Steps

### Step 1: Install and Configure App Host (Host A)

On Host A, install tagave normally:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"

# Choose:
# - Music location: NFS/SMB mount (shared)
# - Workers: "Separate host (I'll run workers elsewhere)"
# - Worker host IP: 192.168.1.20 (or your worker's IP)
```

The installer generates `.env` and `docker-compose.yml`.

### Step 2: Note Your Database URL

After setup, note your database password and Host A's IP:

```bash
# On Host A
grep POSTGRES_PASSWORD .env
hostname -I  # Get Host A's IP
```

You'll need these for the worker host.

### Step 3: Configure Music Mount

Ensure the music library is accessible on Host A (if workers use NFS/SMB from Host A):

```bash
# Mount music on Host A if needed
mkdir -p /mnt/music
mount -t nfs nas.local:/export/music /mnt/music
# or
mount -t cifs //nas.local/music /mnt/music -o username=user,password=pass

# Verify
ls /mnt/music
```

### Step 4: Start App Host

```bash
docker compose up -d
sleep 30
curl http://localhost:3100/api/system/health
```

### Step 5: Install Worker Host (Host B)

On Host B, create a directory for tagave:

```bash
mkdir -p ~/tagave
cd ~/tagave
```

### Step 6: Create .env on Worker Host

```bash
# On Host B, create .env with the app host's database connection string
cat > .env <<EOF
# Worker configuration (split topology)
APP_SECRET=$(ssh user@192.168.1.10 'grep APP_SECRET .env | cut -d= -f2')
POSTGRES_PASSWORD=$(ssh user@192.168.1.10 'grep POSTGRES_PASSWORD .env | cut -d= -f2')
DATABASE_URL=postgres://liner:$POSTGRES_PASSWORD@192.168.1.10:5432/liner
MUSIC_DIR=/mnt/music
EOF
```

Or manually copy from Host A:

```bash
# Option 1: SSH and copy
ssh user@192.168.1.10 cat .env > .env

# Option 2: Manually create (replace with actual values)
cat > .env <<EOF
APP_SECRET=your_secret_from_host_a
POSTGRES_PASSWORD=your_postgres_password
DATABASE_URL=postgres://liner:your_postgres_password@192.168.1.10:5432/liner
MUSIC_DIR=/mnt/music
EOF
```

### Step 7: Create docker-compose.yml on Worker Host

On Host B, create a simplified docker-compose with only workers:

```bash
cat > docker-compose.yml <<'EOF'
version: '3.8'

services:
  worker-file:
    image: ghcr.io/xooxoxxo/tagave:latest
    command: node packages/worker/dist/cli.js file
    environment:
      DATABASE_URL: ${DATABASE_URL}
      APP_SECRET: ${APP_SECRET}
      MUSIC_DIR: ${MUSIC_DIR}
      LOG_LEVEL: info
    volumes:
      - ${MUSIC_DIR}:/mnt/music:ro
      - tagave-cache:/cache
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "localhost", "-U", "liner"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - tagave

  worker-identify:
    image: ghcr.io/xooxoxxo/tagave:latest
    command: node packages/worker/dist/cli.js identify
    environment:
      DATABASE_URL: ${DATABASE_URL}
      APP_SECRET: ${APP_SECRET}
      LOG_LEVEL: info
    restart: unless-stopped
    depends_on:
      - worker-file
    networks:
      - tagave

volumes:
  tagave-cache:

networks:
  tagave:
    driver: bridge
EOF
```

### Step 8: Mount Music on Worker Host

```bash
# Mount music on Host B (from NAS or Host A)
mkdir -p /mnt/music

# Option A: Mount from NAS
sudo mount -t nfs nas.local:/export/music /mnt/music

# Option B: Mount from Host A (if music is on Host A)
sudo mount -t nfs 192.168.1.10:/path/to/music /mnt/music

# Option C: Mount SMB from NAS
sudo mount -t cifs //nas.local/music /mnt/music -o username=user,password=pass

# Verify
ls /mnt/music
```

### Step 9: Start Workers

```bash
# On Host B
docker compose up -d

# Wait for services to start
sleep 10

# Check logs
docker compose logs worker-file
docker compose logs worker-identify
```

### Step 10: Verify Connection

```bash
# On Host B, verify connection to database
docker compose exec worker-file pg_isready -h 192.168.1.10 -U liner

# Should output: accepting connections
```

## Configuration

### Environment Variables on Worker Host

| Variable | Example | Purpose |
|----------|---------|---------|
| `APP_SECRET` | (from app host) | Must match app host |
| `DATABASE_URL` | `postgres://liner:pass@192.168.1.10:5432/liner` | Connection to app host database |
| `MUSIC_DIR` | `/mnt/music` | Mount point on worker host |

### Docker Compose on Worker Host

The simplified worker docker-compose:
- Runs only `worker-file` and `worker-identify` services
- Mounts `/mnt/music` read-only
- Connects to postgres on app host via DATABASE_URL
- Uses a local cache volume

## Health Checks

### Worker Won't Connect to Database

```bash
# On Worker Host (Host B)
docker compose exec worker-file pg_isready -h 192.168.1.10 -U liner

# If fails:
# 1. Check app host is running
# 2. Check firewall: ssh user@192.168.1.10 sudo ufw allow 5432
# 3. Check database password in .env
# 4. Verify network routing: ping 192.168.1.10
```

### Music Not Found

```bash
# On Worker Host (Host B)
ls /mnt/music

# If empty:
# 1. Check mount: mount | grep music
# 2. Verify NAS/Host A is reachable
# 3. Remount: sudo umount /mnt/music && sudo mount -t nfs ...
```

### Workers Stuck in Pending State

```bash
# On App Host (Host A)
docker compose logs worker-file | tail -20
docker compose logs worker-identify | tail -20

# Check database connectivity from app
docker compose exec api node packages/doctor/dist/cli.js doctor
```

## Updating Workers

To update workers on Host B:

```bash
# On Host B
docker compose pull
docker compose up -d

# Wait and verify
docker compose logs -f worker-file | head -20
```

To update the app on Host A:

```bash
# On Host A
docker compose pull
docker compose up -d

# Wait and verify
curl http://localhost:3100/api/system/health
```

You can update each host independently; in-flight jobs will retry automatically.

## Troubleshooting Split Topology

### "Workers not responding" on app host

```bash
# On Host A, check if workers are running
docker compose ps  # Shows workers if on same host

# If workers are on Host B:
ssh user@192.168.1.20 docker compose ps

# Verify network connectivity
ssh user@192.168.1.20 pg_isready -h 192.168.1.10 -U liner
```

### Workers connect but don't scan

```bash
# On Host B, check music directory
ls /mnt/music

# Check worker logs
docker compose logs worker-file
docker compose logs worker-identify

# Verify cache volume has space
docker compose exec worker-file df -h /cache
```

### Database password mismatch

Workers won't connect if DATABASE_URL has wrong password.

```bash
# On Host A, check actual password
grep POSTGRES_PASSWORD .env

# On Host B, update .env
cat >> .env <<EOF
DATABASE_URL=postgres://liner:correct_password@192.168.1.10:5432/liner
EOF

# Restart workers
docker compose up -d --force-recreate
```

### NFS mount unmounted after reboot

Make the music mount persistent:

```bash
# On Host B, add to /etc/fstab
echo "nas.local:/export/music /mnt/music nfs defaults 0 0" | sudo tee -a /etc/fstab

# Remount all
sudo mount -a

# Verify
mount | grep music
```

## Disaster Recovery (Split Topology)

If Host B (worker) fails:

1. Scans pause but don't fail
2. Restart Host B with the same `.env`
3. Workers reconnect and resume from where they left off

If Host A (app) fails:

1. No scanning possible until restored
2. Restore Host A from backup (see [Backup Guide](backup-restore.md))
3. Workers will reconnect automatically

## See Also

- [Installation Guide](installation.md) — Single-host setup
- [Backup & Restore](backup-restore.md) — Backing up with split topology
- [Troubleshooting](troubleshooting.md) — Common issues

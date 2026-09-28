# Docker Compose Installation (Linux, macOS, Windows)

This guide covers installing tagave using Docker Compose on any operating system.

## Prerequisites

- **Docker**: 20.10 or later
  - Linux: `sudo apt install docker.io` (Ubuntu/Debian) or equivalent
  - macOS/Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop)

- **Docker Compose**: v2 (included with Docker Desktop)
  - Linux: `sudo apt install docker-compose` or `docker-compose-plugin`
  - Verify: `docker compose version`

- **2 GB RAM** available for containers
- **5 GB disk space** minimum (more for larger libraries)

## Installation

### Option 1: Automated Installer (Recommended)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
```

The installer handles:
- Prerequisite checks
- Interactive setup (music path, worker topology)
- Secret generation
- File creation
- Service startup

Answer the prompts and you're done.

### Option 2: Manual Setup

#### 1. Clone or Download

```bash
git clone https://github.com/xooxoxxo/tagave.git
cd tagave
```

#### 2. Create Configuration

```bash
# Generate APP_SECRET
APP_SECRET=$(openssl rand -hex 32)

# Create .env file
cat > .env <<EOF
APP_SECRET=$APP_SECRET
MUSIC_DIR=/mnt/music
EOF

# Update .env with your settings
$EDITOR .env  # or: nano .env, vi .env, etc.
```

#### 3. Prepare Music Directory

```bash
# Local path
mkdir -p /mnt/music
# Or mount NFS
sudo mount -t nfs nas.local:/export/music /mnt/music
# Or mount SMB
sudo mount -t cifs //nas.local/music /mnt/music -o username=user,password=pass
```

#### 4. Start Services

```bash
docker compose up -d

# Wait for services to start
sleep 30

# Check status
docker compose ps
```

#### 5. Complete Setup

Open http://localhost:3100/setup in your browser and follow the wizard.

## Post-Installation

### Access the Web Interface

- **Local machine**: http://localhost:3100
- **From another computer**: http://your-server-ip:3100
- **With hostname**: http://your-hostname:3100 (if your network supports mDNS)

### Add Your Music

1. Go to Settings → Music Library → Scan Roots
2. Click "Add Scan Root"
3. Enter the path: `/mnt/music` (or wherever your music is mounted)
4. Click "Start Scan"

The file worker will begin scanning your library. This may take minutes to hours depending on library size.

### Check Status

```bash
# View running containers
docker compose ps

# View logs
docker compose logs -f api

# Check system health
curl http://localhost:3100/api/system/health
```

## Configuration

### Port Mapping

By default, tagave uses port 3100. To use a different port:

```bash
# Edit docker-compose.yml
docker compose stop
docker compose up -d --force-recreate

# Or set in environment
PORT=3200 docker compose up -d
```

Then access at the new port: http://localhost:3200

### Music Directory

Set `MUSIC_DIR` in `.env` to your music path:

```bash
# Local path
MUSIC_DIR=/mnt/music

# NFS mount
MUSIC_DIR=/mnt/nfs/music

# SMB mount (after mounting with cifs)
MUSIC_DIR=/mnt/smb/music
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `APP_SECRET` | Session + encryption key | (required) |
| `MUSIC_DIR` | Music library path | `/mnt/music` |
| `PUBLIC_URL` | External URL (for proxy) | `http://localhost:3100` |
| `LOG_LEVEL` | Logging: debug/info/warn/error | `info` |
| `ALLOW_INSECURE_HTTP` | Allow HTTP cookies (dev) | `false` |

## Maintenance

### Update tagave

```bash
# Back up database
docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump

# Pull latest image
docker compose pull

# Restart services
docker compose up -d

# Verify
docker compose ps
curl http://localhost:3100/api/system/health
```

See [Upgrading Guide](../upgrading.md) for detailed update procedures.

### Backup Your Data

```bash
# Create backup
docker compose exec postgres pg_dump -U liner -Fc liner > backup-$(date +%s).pgdump

# Backup configuration
cp .env env-backup-$(date +%s)

# Store securely (not in git or public cloud without encryption)
```

See [Backup Guide](../backup-restore.md) for automated backups.

### Stop and Restart

```bash
# Stop services (keep data)
docker compose stop

# Start services
docker compose start

# Restart specific service
docker compose restart api
```

### Clean Up

```bash
# Remove stopped containers (keeps images and volumes)
docker compose down

# Remove everything (⚠️ deletes all data)
docker compose down -v
```

## Troubleshooting

### Docker not installed
```bash
# Check installation
docker --version
docker compose version

# Install if needed
# macOS/Windows: Docker Desktop
# Linux: sudo apt install docker.io docker-compose
```

### Permission denied
```bash
# Add user to docker group (Linux)
sudo usermod -aG docker $USER
newgrp docker
```

### Port already in use
```bash
# Find what's using port 3100
lsof -i :3100

# Or use a different port in .env or docker-compose.yml
```

### Container won't start
```bash
# Check logs
docker compose logs api
docker compose logs postgres
docker compose logs worker-file

# Restart
docker compose restart
```

### Music path not found
```bash
# Verify path exists
ls -la /mnt/music

# For NFS/SMB, verify mount
mount | grep music

# Check permissions
docker compose exec worker-file ls /mnt/music
```

## Advanced: Systemd Service (Linux)

Create a systemd service to start tagave on boot:

```bash
# Create service file
sudo tee /etc/systemd/system/tagave.service > /dev/null <<EOF
[Unit]
Description=Tagave Music Catalog
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/path/to/tagave
ExecStart=docker compose up
ExecStop=docker compose down
Restart=unless-stopped
User=your-username

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl enable tagave.service
sudo systemctl start tagave.service

# Check status
sudo systemctl status tagave.service
```

## Advanced: Reverse Proxy with HTTPS

Set up nginx or Traefik in front of tagave:

```bash
# Set PUBLIC_URL to external URL
echo "PUBLIC_URL=https://music.example.com" >> .env
echo "ALLOW_INSECURE_HTTP=true" >> .env

# Restart
docker compose up -d

# Configure nginx to forward to http://localhost:3100
# Configure Traefik labels in docker-compose.yml
```

See your reverse proxy docs for exact configuration.

## File Structure

```
tagave/
├── docker-compose.yml        # Service definitions
├── .env                       # Configuration (generated)
├── .env.example              # Template
├── .gitignore               # Excludes .env, cache, backups
│
├── packages/
│   ├── api/                 # HTTP server
│   ├── web/                 # React web UI
│   ├── worker/              # File and identify workers
│   ├── db/                  # Database schema + migrations
│   └── core/                # Shared code
│
├── docs/
│   ├── installation.md       # This guide
│   ├── upgrading.md         # Version updates
│   ├── backup-restore.md    # Backup procedures
│   ├── split-topology.md    # Multi-host setup
│   └── troubleshooting.md   # Common issues
│
└── CHANGELOG.md             # Release notes + migration guides
```

## See Also

- [Installation Guide](../installation.md) — Full install walkthrough
- [Upgrading Guide](../upgrading.md) — Version updates
- [Backup & Restore](../backup-restore.md) — Data protection
- [Split Topology](../split-topology.md) — Multi-host setup
- [Troubleshooting](../troubleshooting.md) — Common issues

## Questions or Issues?

- GitHub Issues: https://github.com/xooxoxxo/tagave/issues
- Include: error message, `docker compose ps`, `docker compose logs api`

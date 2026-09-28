#!/usr/bin/env bash
#
# Tagave Installer
# Interactive setup for self-hosted music catalogue
#
# Usage:
#   bash -c "$(curl -L https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
#   OR
#   bash ./install-tagave.sh
#

set -euo pipefail

# ============================================================================
# Configuration & Defaults
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-.}"
ENV_FILE="${INSTALL_DIR}/.env"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
COMPOSE_WORKERS_FILE="${INSTALL_DIR}/docker-compose.workers.yml"

# ============================================================================
# Color Output (portable, works on macOS and Linux)
# ============================================================================

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m' # No Color

log_header() {
    echo "${BLUE}=== $1 ===${NC}"
}

log_success() {
    echo "${GREEN}✓ $1${NC}"
}

log_warning() {
    echo "${YELLOW}⚠ $1${NC}"
}

log_error() {
    echo "${RED}✗ $1${NC}"
}

log_info() {
    echo "  $1"
}

# ============================================================================
# Prerequisites Check
# ============================================================================

check_prerequisites() {
    log_header "Checking Prerequisites"

    local missing=0

    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker 20.10+ from https://docs.docker.com/get-docker/"
        missing=1
    else
        local docker_version=$(docker --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
        log_success "Docker ${docker_version} found"
    fi

    # Check Docker Compose v2
    if ! command -v docker &> /dev/null || ! docker compose version &> /dev/null; then
        log_error "Docker Compose v2 not found. Ensure Docker Desktop or docker-compose-plugin is installed."
        missing=1
    else
        local compose_version=$(docker compose version --short)
        log_success "Docker Compose ${compose_version} found"
    fi

    # Check available RAM (at least 2GB)
    if command -v free &> /dev/null; then
        local available_mb=$(free -m | awk 'NR==2 {print $7}')
        if [ "$available_mb" -lt 1500 ]; then
            log_warning "Less than 2 GB available RAM (${available_mb} MB). Consider closing applications."
        else
            log_success "Sufficient RAM available (${available_mb} MB)"
        fi
    fi

    # Check available disk (at least 5GB)
    local available_gb=$(df -Bg "$INSTALL_DIR" | awk 'NR==2 {print $4}' | sed 's/G//')
    if [ "$available_gb" -lt 5 ]; then
        log_error "Less than 5 GB available disk space. Free up space and try again."
        missing=1
    else
        log_success "Sufficient disk space available (${available_gb} GB)"
    fi

    if [ $missing -eq 1 ]; then
        log_error "Please fix missing prerequisites and run the installer again."
        exit 1
    fi
}

# ============================================================================
# Interactive Prompts
# ============================================================================

prompt_hostname() {
    log_header "System Hostname"
    log_info "This hostname is used for service discovery and logging."
    log_info "Examples: music.local, tagave, homelab"

    local default="tagave.local"
    read -p "Hostname or domain [$default]: " hostname
    hostname="${hostname:-$default}"

    echo "$hostname"
}

prompt_timezone() {
    log_header "Timezone"
    log_info "Used for scheduled jobs and log timestamps."
    log_info "Examples: America/New_York, Europe/London, Asia/Tokyo, UTC"

    local default="UTC"
    read -p "Timezone [$default]: " timezone
    timezone="${timezone:-$default}"

    echo "$timezone"
}

prompt_music_source() {
    log_header "Music Library Location"
    log_info "Where does your music library live?"
    echo ""
    echo "  (1) Local path on this computer"
    echo "  (2) NFS mount (network storage)"
    echo "  (3) SMB/CIFS mount (Windows network share)"
    echo "  (4) I'll configure it later in the setup wizard"
    echo ""

    local choice
    read -p "Choice (1-4): " choice

    echo "$choice"
}

prompt_local_music_path() {
    log_header "Music Library Path"
    log_info "Absolute path to your music folder."
    log_info "Examples: /home/user/Music, /mnt/nas/music, /Volumes/Music"

    local default="/mnt/music"
    read -p "Music path [$default]: " path
    path="${path:-$default}"

    echo "$path"
}

prompt_nfs_config() {
    log_header "NFS Configuration"

    local default_host="192.168.1.10"
    read -p "NAS hostname or IP [$default_host]: " nas_host
    nas_host="${nas_host:-$default_host}"

    local default_path="/mnt/music"
    read -p "NAS export path [$default_path]: " nas_path
    nas_path="${nas_path:-$default_path}"

    echo "$nas_host|$nas_path"
}

prompt_smb_config() {
    log_header "SMB Configuration"

    local default_path="//nas.local/music"
    read -p "SMB/CIFS path [$default_path]: " smb_path
    smb_path="${smb_path:-$default_path}"

    read -p "SMB username: " smb_user
    read -sp "SMB password: " smb_pass
    echo ""

    echo "$smb_path|$smb_user|$smb_pass"
}

prompt_topology() {
    log_header "Worker Deployment"
    log_info "How should workers be deployed?"
    echo ""
    echo "  (1) All-in-one: API and workers on this computer"
    echo "  (2) Split: API here, workers on different computer"
    echo ""

    local choice
    read -p "Choice (1-2): " choice

    echo "$choice"
}

prompt_worker_host() {
    log_header "Worker Host Configuration"
    log_info "IP address or hostname of the machine running workers."
    log_info "This machine must be able to reach the database at this computer."
    log_info "Examples: 192.168.1.20, worker.local"

    local default="192.168.1.20"
    read -p "Worker host [$default]: " worker_host
    worker_host="${worker_host:-$default}"

    echo "$worker_host"
}

prompt_backups() {
    log_header "Backup Configuration (Optional)"
    log_info "Enable automated daily database backups?"

    read -p "Enable backups? (y/n) [y]: " enable_backups
    enable_backups="${enable_backups:-y}"

    if [[ "$enable_backups" =~ ^[yY]$ ]]; then
        local default_location="./backups"
        read -p "Backup location [$default_location]: " backup_location
        backup_location="${backup_location:-$default_location}"
        echo "true|$backup_location"
    else
        echo "false|"
    fi
}

# ============================================================================
# Secret Generation
# ============================================================================

generate_secret() {
    # Generate 32 bytes of random data and encode as base64
    # Works on macOS and Linux
    if command -v openssl &> /dev/null; then
        openssl rand -32 | base64 | tr -d '\n'
    else
        # Fallback: use /dev/urandom
        head -c 32 /dev/urandom | base64 | tr -d '\n'
    fi
}

# ============================================================================
# File Generation
# ============================================================================

create_env_file() {
    local app_secret="$1"
    local postgres_password="$2"
    local hostname="$3"
    local timezone="$4"
    local music_dir="$5"
    local worker_topology="$6"
    local worker_host="$7"
    local backup_enabled="$8"
    local backup_location="$9"

    log_header "Creating Configuration"

    # Backup existing .env if it exists
    if [ -f "$ENV_FILE" ]; then
        log_warning "Found existing .env file. Backing up to .env.backup"
        cp "$ENV_FILE" "${ENV_FILE}.backup"
    fi

    cat > "$ENV_FILE" << EOF
# Tagave Installation Configuration
# Generated by install-tagave.sh on $(date)
# Back this file up securely; it contains secrets

# ==== SECURITY ====
APP_SECRET=$app_secret
POSTGRES_PASSWORD=$postgres_password

# ==== DATABASE ====
POSTGRES_USER=liner
POSTGRES_DB=liner

# ==== NETWORK ====
PUBLIC_URL=http://$hostname:3100
ALLOW_INSECURE_HTTP=true
HOSTNAME=$hostname
TIMEZONE=$timezone

# ==== STORAGE ====
CACHE_DIR=/cache
MUSIC_DIR=$music_dir

# ==== TOPOLOGY ====
WORKER_TOPOLOGY=$worker_topology
WORKER_HOST=$worker_host

# ==== BACKUP ====
BACKUP_ENABLED=$backup_enabled
BACKUP_LOCATION=$backup_location
BACKUP_SCHEDULE=0 2 * * *

# ==== LOGGING ====
LOG_LEVEL=info
METRICS_ENABLED=false
EOF

    log_success "Configuration written to $ENV_FILE"
}

# ============================================================================
# Docker Compose Generation
# ============================================================================

create_docker_compose() {
    log_header "Creating Docker Compose Configuration"

    # The docker-compose.yml is already in the repo with environment variable substitution
    # We just need to ensure it exists or is not modified
    if [ ! -f "$COMPOSE_FILE" ]; then
        log_error "docker-compose.yml not found in $INSTALL_DIR"
        exit 1
    fi

    log_success "Using docker-compose.yml from repository"
}

# ============================================================================
# Service Startup & Health Checks
# ============================================================================

start_services() {
    log_header "Starting Services"

    cd "$INSTALL_DIR"

    log_info "Pulling latest images..."
    docker compose pull

    log_info "Starting containers..."
    docker compose up -d

    log_success "Containers started"
}

wait_for_health() {
    local service="$1"
    local max_attempts=30
    local attempt=0

    log_info "Waiting for $service..."

    while [ $attempt -lt $max_attempts ]; do
        if docker compose exec -T "$service" pg_isready -U liner &> /dev/null 2>&1; then
            return 0
        elif [ "$service" = "app" ]; then
            if curl -sf http://localhost:3100/_health > /dev/null 2>&1; then
                return 0
            fi
        fi

        attempt=$((attempt + 1))
        sleep 1
    done

    return 1
}

validate_services() {
    log_header "Validating Services"

    cd "$INSTALL_DIR"

    # Check postgres
    if wait_for_health postgres; then
        log_success "Database connected"
    else
        log_warning "Database not responding yet (will be ready shortly)"
    fi

    # Check API
    if wait_for_health app; then
        log_success "API responding"
    else
        log_warning "API not responding yet (will be ready shortly)"
    fi

    # If split topology, validate worker can reach postgres
    if [ -f "$ENV_FILE" ]; then
        local topology=$(grep '^WORKER_TOPOLOGY=' "$ENV_FILE" | cut -d'=' -f2)
        if [ "$topology" = "split" ]; then
            local worker_host=$(grep '^WORKER_HOST=' "$ENV_FILE" | cut -d'=' -f2)
            log_info "Validating worker host can reach database..."
            if nc -z -w 2 "$worker_host" 5432 &> /dev/null; then
                log_success "Worker host $worker_host is reachable"
            else
                log_warning "Could not validate worker host connectivity"
                log_info "Make sure worker host can reach postgres at this machine:5432"
            fi
        fi
    fi
}

# ============================================================================
# Success Output
# ============================================================================

show_success() {
    echo ""
    log_header "Setup Complete!"
    echo ""
    echo "Your Tagave music catalogue is now starting up."
    echo ""
    echo "Next steps:"
    echo "  1. Open your browser and visit:"
    echo "     ${BLUE}http://localhost:3100/setup${NC}"
    echo ""
    echo "  2. If accessing from another computer, use your IP address:"
    echo "     ${BLUE}http://<your-server-ip>:3100/setup${NC}"
    echo ""
    echo "  3. Follow the setup wizard to:"
    echo "     - Create an admin account"
    echo "     - Configure your music library"
    echo "     - Add external API tokens (optional)"
    echo ""
    echo "Configuration has been saved to:"
    echo "  ${BLUE}${ENV_FILE}${NC}"
    echo ""
    echo "To view service status:"
    echo "  ${BLUE}docker compose ps${NC}"
    echo ""
    echo "To view logs:"
    echo "  ${BLUE}docker compose logs -f app${NC}"
    echo ""
    echo "To stop services:"
    echo "  ${BLUE}docker compose down${NC}"
    echo ""
}

# ============================================================================
# Music Path Testing
# ============================================================================

test_music_path() {
    local music_type="$1"
    local music_path="$2"

    log_header "Testing Music Path"

    case "$music_type" in
        1)
            # Local path
            if [ -d "$music_path" ]; then
                log_success "Music path is accessible: $music_path"
            else
                log_warning "Music path does not exist: $music_path"
                log_info "You can create it later or from the setup wizard"
            fi
            ;;
        2)
            # NFS
            local nas_host=$(echo "$music_path" | cut -d'|' -f1)
            local nas_path=$(echo "$music_path" | cut -d'|' -f2)
            if command -v showmount &> /dev/null; then
                if showmount -e "$nas_host" &> /dev/null; then
                    log_success "NAS $nas_host is reachable"
                else
                    log_warning "Could not reach NAS at $nas_host"
                fi
            else
                log_info "Cannot verify NFS without showmount. You can test after install."
            fi
            ;;
        3)
            # SMB
            log_info "SMB configuration will be applied after services start"
            ;;
        *)
            log_info "Music path will be configured in the setup wizard"
            ;;
    esac
}

# ============================================================================
# Main Installer Flow
# ============================================================================

main() {
    clear

    echo "${BLUE}"
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║  Tagave: Self-Hosted Music Catalogue Installer         ║"
    echo "╚════════════════════════════════════════════════════════╝"
    echo "${NC}"
    echo ""

    # Prerequisites
    check_prerequisites
    echo ""

    # Interactive prompts
    hostname=$(prompt_hostname)
    echo ""

    timezone=$(prompt_timezone)
    echo ""

    music_source=$(prompt_music_source)
    echo ""

    case "$music_source" in
        1)
            music_dir=$(prompt_local_music_path)
            test_music_path 1 "$music_dir"
            ;;
        2)
            nfs_config=$(prompt_nfs_config)
            music_dir="/mnt/music"  # standardized mount point
            test_music_path 2 "$nfs_config"
            ;;
        3)
            smb_config=$(prompt_smb_config)
            music_dir="/mnt/music"  # standardized mount point
            test_music_path 3 "$smb_config"
            ;;
        *)
            music_dir="/mnt/music"
            test_music_path 4 ""
            ;;
    esac
    echo ""

    topology=$(prompt_topology)
    echo ""

    if [ "$topology" = "2" ]; then
        worker_topology="split"
        worker_host=$(prompt_worker_host)
    else
        worker_topology="single-host"
        worker_host="localhost"
    fi
    echo ""

    backup_config=$(prompt_backups)
    backup_enabled=$(echo "$backup_config" | cut -d'|' -f1)
    backup_location=$(echo "$backup_config" | cut -d'|' -f2)
    if [ -z "$backup_location" ]; then
        backup_location="/backup"
    fi
    echo ""

    # Generate secrets
    log_header "Generating Secrets"
    app_secret=$(generate_secret)
    postgres_password=$(generate_secret)
    log_success "Generated APP_SECRET and POSTGRES_PASSWORD"
    echo ""

    # Create configuration files
    create_env_file "$app_secret" "$postgres_password" "$hostname" "$timezone" \
        "$music_dir" "$worker_topology" "$worker_host" "$backup_enabled" "$backup_location"
    echo ""

    create_docker_compose
    echo ""

    # Start services
    start_services
    echo ""

    # Validate
    validate_services
    echo ""

    # Show success
    show_success
}

# Run the installer
main "$@"

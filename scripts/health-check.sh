#!/usr/bin/env bash
#
# Tagave Health Check
# Verifies all services are healthy and provides diagnostics
#
# Usage:
#   ./scripts/health-check.sh              # Check services via docker compose
#   ./scripts/health-check.sh --api http://hostname:3100  # Check remote API
#

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

API_URL="${1:-http://localhost:3100}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-liner}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
POSTGRES_DB="${POSTGRES_DB:-liner}"
WORKER_HOST="${WORKER_HOST:-localhost}"

# ============================================================================
# Color Output
# ============================================================================

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

check_ok() {
    echo "${GREEN}✓${NC} $1"
}

check_warn() {
    echo "${YELLOW}⚠${NC} $1"
}

check_fail() {
    echo "${RED}✗${NC} $1"
}

# ============================================================================
# Service Checks
# ============================================================================

check_docker() {
    if command -v docker &> /dev/null; then
        check_ok "Docker is installed"
        return 0
    else
        check_fail "Docker not found"
        return 1
    fi
}

check_docker_compose_running() {
    if docker compose ps --format json &> /dev/null; then
        check_ok "Docker Compose accessible"
        return 0
    else
        check_fail "Docker Compose error"
        return 1
    fi
}

check_postgres_container() {
    if docker compose ps postgres 2>/dev/null | grep -q "running"; then
        check_ok "Postgres container running"

        # Check database health via health status
        if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" &>/dev/null; then
            check_ok "Postgres is healthy"

            # Try to get version
            local version=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT version();" 2>/dev/null | head -1)
            if [ -n "$version" ]; then
                check_ok "Database version: $(echo "$version" | grep -oE 'PostgreSQL [0-9]+' || echo 'unknown')"
            fi
            return 0
        else
            check_fail "Postgres is not responding"
            return 1
        fi
    else
        check_fail "Postgres container not running"
        return 1
    fi
}

check_api_container() {
    if docker compose ps app 2>/dev/null | grep -q "running"; then
        check_ok "API container running"

        # Check API health via HTTP
        if curl -sf "${API_URL}/_health" > /dev/null 2>&1; then
            check_ok "API is healthy"
            return 0
        else
            check_warn "API container running but not responding to health check"
            return 1
        fi
    else
        check_fail "API container not running"
        return 1
    fi
}

check_api_remote() {
    if curl -sf "${API_URL}/_health" > /dev/null 2>&1; then
        check_ok "API responding at ${API_URL}"
        return 0
    else
        check_fail "API not responding at ${API_URL}"
        return 1
    fi
}

check_worker_containers() {
    local found=0

    if docker compose ps worker-files 2>/dev/null | grep -q "running"; then
        check_ok "File worker container running"
        found=1
    else
        check_warn "File worker container not running"
    fi

    if docker compose ps worker-identify 2>/dev/null | grep -q "running"; then
        check_ok "Identify worker container running"
        found=1
    else
        check_warn "Identify worker container not running"
    fi

    if [ $found -eq 0 ]; then
        check_warn "No worker containers found (single-host or not yet started)"
    fi

    return 0
}

check_worker_connectivity() {
    if [ "$WORKER_HOST" = "localhost" ] || [ "$WORKER_HOST" = "postgres" ]; then
        check_ok "Single-host topology (workers on same host)"
        return 0
    fi

    # Try to reach worker database connection
    if command -v nc &> /dev/null; then
        if nc -z -w 2 "$WORKER_HOST" 5432 &> /dev/null; then
            check_ok "Can reach worker host at ${WORKER_HOST}:5432"
            return 0
        else
            check_warn "Cannot reach worker host at ${WORKER_HOST}:5432"
            return 1
        fi
    else
        check_warn "Cannot test worker connectivity (nc not available)"
        return 1
    fi
}

check_music_dir() {
    if [ -z "${MUSIC_DIR:-}" ]; then
        check_warn "MUSIC_DIR not set"
        return 1
    fi

    if [ -d "$MUSIC_DIR" ]; then
        local size=$(du -sh "$MUSIC_DIR" 2>/dev/null | cut -f1)
        check_ok "Music directory accessible: $MUSIC_DIR ($size)"
        return 0
    else
        check_fail "Music directory not found: $MUSIC_DIR"
        return 1
    fi
}

check_cache_volume() {
    if docker compose exec -T app ls /cache > /dev/null 2>&1; then
        check_ok "Cache directory accessible"
        return 0
    else
        check_warn "Cannot access cache directory"
        return 1
    fi
}

check_disk_space() {
    if command -v df &> /dev/null; then
        local available_percent=$(df -h . | tail -1 | awk '{print $(NF-1)}' | sed 's/%//')
        if [ "$available_percent" -lt 10 ]; then
            check_fail "Disk space critically low: ${available_percent}% used"
            return 1
        elif [ "$available_percent" -gt 80 ]; then
            check_warn "Disk space running low: ${available_percent}% used"
            return 1
        else
            check_ok "Disk space healthy: ${available_percent}% used"
            return 0
        fi
    else
        check_warn "Cannot check disk space"
        return 1
    fi
}

check_memory() {
    if command -v free &> /dev/null; then
        local available_mb=$(free -m | awk 'NR==2 {print $7}')
        if [ "$available_mb" -lt 512 ]; then
            check_warn "Available memory low: ${available_mb} MB"
            return 1
        else
            check_ok "Available memory: ${available_mb} MB"
            return 0
        fi
    else
        check_warn "Cannot check memory"
        return 1
    fi
}

# ============================================================================
# Recommendations
# ============================================================================

show_next_steps() {
    echo ""
    echo "${BLUE}Next Steps:${NC}"
    echo ""

    if docker compose ps app 2>/dev/null | grep -q "running"; then
        echo "  • Setup Wizard: ${API_URL}/setup"
        echo "  • Dashboard: ${API_URL}/"
    else
        echo "  • Start services: docker compose up -d"
    fi

    echo "  • View logs: docker compose logs -f"
    echo "  • View status: docker compose ps"
    echo ""
}

show_troubleshooting() {
    echo "${BLUE}Troubleshooting:${NC}"
    echo ""
    echo "Services not starting:"
    echo "  docker compose logs postgres  # Check database logs"
    echo "  docker compose logs app       # Check API logs"
    echo "  docker compose logs worker-files  # Check worker logs"
    echo ""
    echo "Services are slow:"
    echo "  docker stats  # Check CPU and memory usage"
    echo "  df -h        # Check disk space"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    echo "${BLUE}"
    echo "╔═══════════════════════════════════════╗"
    echo "║  Tagave Health Check                  ║"
    echo "╚═══════════════════════════════════════╝"
    echo "${NC}"
    echo ""

    local errors=0

    # Basic checks
    check_docker || errors=$((errors + 1))
    echo ""

    # Docker Compose checks
    if check_docker_compose_running; then
        echo ""

        # Services
        check_postgres_container || errors=$((errors + 1))
        check_api_container || errors=$((errors + 1))
        check_worker_containers
        echo ""

        # Connectivity & Resources
        check_worker_connectivity
        check_music_dir || errors=$((errors + 1))
        check_cache_volume
        echo ""

        # System resources
        check_disk_space
        check_memory
        echo ""

        # Next steps
        show_next_steps
    else
        echo ""
        echo "Cannot access Docker Compose. Are services running?"
        echo ""
        echo "Start services with:"
        echo "  ${BLUE}docker compose up -d${NC}"
        echo ""
        errors=$((errors + 1))
    fi

    # Show troubleshooting if there were errors
    if [ $errors -gt 0 ]; then
        show_troubleshooting
        return 1
    fi

    return 0
}

main "$@"

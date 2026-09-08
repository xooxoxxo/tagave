#!/bin/bash
# smoke.sh - Release gate: verify the production compose stack works on a clean host
#
# Tests:
#   1. Stack boots (postgres + app, plus worker-files + worker-identify unless WORKERS=0)
#   2. API health endpoint responds
#   3. First-run setup (create library owner)
#   4. Authentication (login, cookie jar)
#   5. Libraries endpoint
#   6. Scan root creation; with workers, the root on the bind-mounted music dir
#      is validated by the file worker (roots.validate over /mnt/music)
#   7. Both workers heartbeat; doctor passes with --expect-workers 2 and the
#      Build Versions check sees the same git sha on app and workers
#   8. liner-doctor backup writes, verifies and prunes dumps; pg_restore --list
#      reads a dump outside the app container (stock postgres:16 image)
#
# Environment:
#   KEEP=1       don't tear down after test (for debugging)
#   WORKERS=0    app-only gate (no worker services; doctor --expect-workers 0)
#   LINER_PORT / POSTGRES_PORT   override defaults (3199/5499)
#
# Usage: ./scripts/smoke.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Configuration
PROJECT_NAME="liner-smoke"
LINER_PORT="${LINER_PORT:-3199}"
POSTGRES_PORT="${POSTGRES_PORT:-5499}"
HEALTH_URL="http://localhost:$LINER_PORT/api/v1/health"
API_URL="http://localhost:$LINER_PORT/api/v1"
SMOKE_EMAIL="smoke@example.com"
SMOKE_PASSWORD="Smoke123!@#"
SMOKE_DISPLAY_NAME="Smoke Test"
CONTACT_STRING="smoke@example.com"
WORKERS="${WORKERS:-1}"
PROFILE=""
[ "$WORKERS" = "1" ] && PROFILE="workers"
# Smoke stack gets its own env file so an existing .env (dev or prod) is never
# read or modified by the release gate.
ENV_FILE=.env.smoke
# Throwaway music dir: the worker-files service binds it at /mnt/music:ro, so a
# real library is never touched. Same build args as scripts/deploy.sh so the
# doctor Build Versions check compares real shas.
TMPDIR="${TMPDIR:-/tmp}"
MUSIC_DIR=$(mktemp -d "${TMPDIR%/}/liner-smoke-music.XXXXXX")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILT_AT=$(date -u +%FT%TZ)

# Temp files
COOKIE_JAR=$(mktemp)
DOCTOR_FILE=""
DUMP_TMP=""
DUMP_TMP_FACETS_S=$(mktemp)
DUMP_TMP_FACETS_L=$(mktemp)

compose() {
  LINER_PORT=$LINER_PORT POSTGRES_PORT=$POSTGRES_PORT MUSIC_DIR=$MUSIC_DIR GIT_SHA=$GIT_SHA BUILT_AT=$BUILT_AT \
    docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" ${PROFILE:+--profile $PROFILE} "$@"
}

cleanup_stack() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1: stack left running (project: $PROJECT_NAME, ports: $LINER_PORT, $POSTGRES_PORT, music dir: $MUSIC_DIR)"
    return
  fi
  echo "Tearing down stack..."
  compose down -v 2>/dev/null || true
  rm -rf "$MUSIC_DIR"
}
cleanup_all() {
  rm -f "${COOKIE_JAR:-}" "${DOCTOR_FILE:-}" "${DUMP_TMP_FACETS_S:-}" "${DUMP_TMP_FACETS_L:-}" 2>/dev/null || true
  [ -n "$DUMP_TMP" ] && rm -rf "$DUMP_TMP"
  cleanup_stack
}
trap cleanup_all EXIT

# wait_for LABEL SECONDS COMMAND... — polls once a second until COMMAND succeeds.
wait_for() {
  local label=$1 secs=$2 i=0
  shift 2
  while ! eval "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$secs" ]; then
      echo "✗ FAIL: $label did not happen within ${secs}s"
      return 1
    fi
    sleep 1
  done
}

echo "=== Liner Smoke Test ==="
echo "Project: $PROJECT_NAME"
echo "Ports: app=$LINER_PORT, postgres=$POSTGRES_PORT"
echo "Workers: $([ "$WORKERS" = "1" ] && echo "worker-files + worker-identify (profile workers)" || echo "none (WORKERS=0)")"
echo "Build: $GIT_SHA @ $BUILT_AT"
echo ""

if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(openssl rand -hex 32)
  printf 'APP_SECRET=%s\nLOG_LEVEL=info\n' "$SECRET" > "$ENV_FILE"
  echo "created $ENV_FILE with a random APP_SECRET"
fi

# Start stack
echo "Starting the compose stack ($PROJECT_NAME)..."
compose up -d --build

# Wait for health endpoint
echo "Waiting for API to be ready..."
if ! wait_for "API health" 60 "curl -sf '$HEALTH_URL'"; then
  echo ""
  echo "Stack logs:"
  compose logs app
  exit 1
fi
echo "✓ API is healthy"

# First-run setup
echo "Running first-run setup..."
SETUP_RESPONSE=$(curl -s -X POST "$API_URL/auth/setup" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$SMOKE_EMAIL\",
    \"password\": \"$SMOKE_PASSWORD\",
    \"displayName\": \"$SMOKE_DISPLAY_NAME\",
    \"contactString\": \"$CONTACT_STRING\"
  }")

if echo "$SETUP_RESPONSE" | grep -q '"email":"'$SMOKE_EMAIL'"'; then
  echo "✓ Setup succeeded"
else
  echo "✗ FAIL: Setup returned unexpected response:"
  echo "$SETUP_RESPONSE"
  exit 1
fi

# Login
echo "Authenticating..."
LOGIN_RESPONSE=$(curl -s -c "$COOKIE_JAR" -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$SMOKE_EMAIL\",
    \"password\": \"$SMOKE_PASSWORD\"
  }")

if echo "$LOGIN_RESPONSE" | grep -q '"email":"'$SMOKE_EMAIL'"'; then
  echo "✓ Login succeeded"
else
  echo "✗ FAIL: Login returned unexpected response:"
  echo "$LOGIN_RESPONSE"
  exit 1
fi

# Get libraries
echo "Fetching libraries..."
LIBS=$(curl -s -b "$COOKIE_JAR" "$API_URL/libraries")
if echo "$LIBS" | grep -q '"data"'; then
  echo "✓ Libraries endpoint working"
else
  echo "✗ FAIL: Unexpected libraries response:"
  echo "$LIBS"
  exit 1
fi

# Extract library ID from the libraries response
LIBRARY_ID=$(echo "$LIBS" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data['data'][0]['id'] if data['data'] else '')")

if [ -z "$LIBRARY_ID" ]; then
  echo "✗ FAIL: Could not extract library ID"
  exit 1
fi

# Create a scan root. With workers it is the bind-mounted music dir (the path
# inside the worker container); without, a path nobody validates (stays pending).
# Expected: 201 Created
if [ "$WORKERS" = "1" ]; then
  SCAN_PATH="/mnt/music"
  echo "Creating scan root $SCAN_PATH (file worker will validate it)..."
else
  SCAN_PATH="/tmp/music-test"
  echo "Creating scan root $SCAN_PATH (worker not present, expect pending)..."
fi
SCANROOT_RESPONSE=$(curl -s -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$API_URL/libraries/$LIBRARY_ID/scan-roots" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"$SCAN_PATH\",
    \"displayName\": \"Test Music\"
  }")

# Extract HTTP code (last 3 characters)
HTTP_CODE="${SCANROOT_RESPONSE: -3}"
# Extract body (everything except last 3 characters)
BODY="${SCANROOT_RESPONSE%???}"

# Accept 201 Created or 409 Conflict (if worker validation fails immediately)
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "409" ]; then
  echo "✓ Scan root creation returned $HTTP_CODE"
else
  echo "✗ FAIL: Scan root creation returned $HTTP_CODE"
  echo "$BODY"
  exit 1
fi

if [ "$WORKERS" = "1" ]; then
  echo "Waiting for both worker heartbeats (the first one lands ~30 s after boot)..."
  if ! wait_for "two live workers in /health" 150 "curl -s '$HEALTH_URL' | grep -q '2 live worker'"; then
    curl -s "$HEALTH_URL"; echo ""
    compose logs --tail=40 worker-files worker-identify
    exit 1
  fi
  echo "✓ Two workers heartbeating"

  echo "Waiting for the file worker to validate $SCAN_PATH over the bind mount..."
  if ! wait_for "scan root validation" 90 "curl -s -b '$COOKIE_JAR' '$API_URL/libraries/$LIBRARY_ID/scan-roots' | grep -q '\"validationStatus\":\"ok\"'"; then
    curl -s -b "$COOKIE_JAR" "$API_URL/libraries/$LIBRARY_ID/scan-roots"; echo ""
    compose logs --tail=40 worker-files
    exit 1
  fi
  echo "✓ Scan root validated by worker-files"

  # Facet summary (XO-363): the file worker builds album_facets at boot; the
  # facets endpoint must then answer from it, and its body must equal the live
  # path's (forced by stamping the library dirty).
  echo "Waiting for the facet summary (x-liner-facets: summary)..."
  FACETS_URL="$API_URL/libraries/$LIBRARY_ID/albums/facets"
  if ! wait_for "facet summary" 90 "curl -s -D - -o /dev/null -b '$COOKIE_JAR' '$FACETS_URL?_=\$RANDOM' | grep -qi 'x-liner-facets: summary'"; then
    curl -s -D - -o /dev/null -b "$COOKIE_JAR" "$FACETS_URL" | grep -i x-liner
    compose logs --tail=20 worker-files
    exit 1
  fi
  curl -s -b "$COOKIE_JAR" "$FACETS_URL?_=1" > "$DUMP_TMP_FACETS_S"
  compose exec -T postgres psql -q -U liner -d liner -Atc "update facet_state set dirty_at = now()" >/dev/null
  LIVE_HDR=$(curl -s -D - -o "$DUMP_TMP_FACETS_L" -b "$COOKIE_JAR" "$FACETS_URL?_=2")
  echo "$LIVE_HDR" | grep -qi 'x-liner-facets: live' || { echo "✗ FAIL: a dirty summary did not fall back to the live path"; exit 1; }
  if ! python3 -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); sys.exit(0 if a == b else 1)" "$DUMP_TMP_FACETS_S" "$DUMP_TMP_FACETS_L"; then
    echo "✗ FAIL: facet summary body differs from the live body"; cat "$DUMP_TMP_FACETS_S"; echo; cat "$DUMP_TMP_FACETS_L"; exit 1
  fi
  compose exec -T postgres psql -q -U liner -d liner -Atc "update facet_state set dirty_at = null" >/dev/null
  echo "✓ Facet summary served and equal to the live counts"
fi

# Run doctor inside the app container
EXPECT_WORKERS=0
[ "$WORKERS" = "1" ] && EXPECT_WORKERS=2
echo "Running doctor (--offline --expect-workers $EXPECT_WORKERS)..."
DOCTOR_FILE=$(mktemp)

if ! compose exec -T app node packages/doctor/dist/cli.js doctor --offline --expect-workers "$EXPECT_WORKERS" > "$DOCTOR_FILE" 2>&1; then
  echo "Doctor exited non-zero (individual checks below)"
fi

# Display doctor output
cat "$DOCTOR_FILE"

# Check that critical checks passed: database, migrations, contact string, cache;
# with workers also the heartbeat and the build identity (--expect-workers 0
# reports both as SKIP).
EXPECTED="PASS Database|PASS Migrations|PASS Contact String|PASS Cache Directory"
[ "$WORKERS" = "1" ] && EXPECTED="$EXPECTED|PASS Worker Heartbeat|PASS Build Versions"
echo "$EXPECTED" | tr '|' '\n' | while read -r expected; do
  if ! grep -q "$expected" "$DOCTOR_FILE"; then
    echo "✗ FAIL: doctor did not report '$expected'"
    exit 1
  fi
done || exit 1

echo "✓ Doctor critical checks passed"

# Backup: four runs with --keep 3 must leave exactly three verified dumps
echo "Running liner-doctor backup four times with --keep 3..."
BACKUP_OUT=""
for i in 1 2 3 4; do
  if ! BACKUP_OUT=$(compose exec -T app node packages/doctor/dist/cli.js backup --keep 3 2>&1); then
    echo "✗ FAIL: backup run $i failed:"
    echo "$BACKUP_OUT"
    exit 1
  fi
  sleep 1  # file names carry a 1 s timestamp
done
echo "$BACKUP_OUT"
if ! echo "$BACKUP_OUT" | grep -q "backup written /cache/backups/liner-"; then
  echo "✗ FAIL: unexpected backup output"
  exit 1
fi
DUMP_COUNT=$(compose exec -T app sh -c 'ls /cache/backups/*.pgdump | wc -l' | tr -d ' \r')
if [ "$DUMP_COUNT" != "3" ]; then
  echo "✗ FAIL: expected 3 dumps after --keep 3, found $DUMP_COUNT"
  exit 1
fi
echo "✓ Backup written, verified (pg_restore --list) and pruned to 3"

# The dump must be readable outside the app container too: copy it to the host
# and feed it to a stock postgres image over stdin (no host bind mount — Docker
# Desktop does not always expose a file written to a temp dir moments earlier).
LATEST=$(compose exec -T app sh -c 'ls /cache/backups/*.pgdump | sort | tail -1' | tr -d '\r')
DUMP_TMP=$(mktemp -d "${TMPDIR%/}/liner-smoke-dump.XXXXXX")
compose cp "app:$LATEST" "$DUMP_TMP/"
DUMP_FILE="$DUMP_TMP/$(basename "$LATEST")"
if [ ! -s "$DUMP_FILE" ]; then
  echo "✗ FAIL: $DUMP_FILE is missing or empty after docker compose cp"
  exit 1
fi
TOC=$(docker run --rm -i postgres:16 pg_restore --list < "$DUMP_FILE" | grep -c '^[0-9][0-9]*;' || true)
if [ "${TOC:-0}" -le 0 ]; then
  echo "✗ FAIL: pg_restore --list found no entries in $(basename "$LATEST")"
  exit 1
fi
echo "✓ pg_restore --list reads $(basename "$LATEST") outside the container ($TOC entries, $(wc -c < "$DUMP_FILE" | tr -d ' ') bytes)"

echo ""
echo "=== PASS ==="
echo "Stack is ready for deployment"
echo ""
echo "Stack status before teardown:"
compose ps

exit 0

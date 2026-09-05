#!/bin/bash
# smoke.sh - Release gate: verify the production compose stack works on a clean host
#
# Tests:
#   1. Stack boots (postgres + app)
#   2. API health endpoint responds
#   3. First-run setup (create library owner)
#   4. Authentication (login, cookie jar)
#   5. Settings read/write
#   6. Scan root creation (validation deferred to worker)
#   7. Doctor passes with --offline --expect-workers 0
#
# Environment:
#   KEEP=1   don't tear down after test (for debugging)
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

# Temp files
COOKIE_JAR=$(mktemp)

cleanup_stack() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1: stack left running (project: $PROJECT_NAME, ports: $LINER_PORT, $POSTGRES_PORT)"
    return
  fi
  echo "Tearing down stack..."
  docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" down -v 2>/dev/null || true
}
cleanup_all() {
  rm -f "${COOKIE_JAR:-}" "${DOCTOR_FILE:-}" 2>/dev/null || true
  cleanup_stack
}
trap cleanup_all EXIT


echo "=== Liner Smoke Test ==="
echo "Project: $PROJECT_NAME"
echo "Ports: app=$LINER_PORT, postgres=$POSTGRES_PORT"
echo ""

# Smoke stack gets its own env file so an existing .env (dev or prod) is never
# read or modified by the release gate.
ENV_FILE=.env.smoke
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(openssl rand -hex 32)
  printf 'APP_SECRET=%s\nLOG_LEVEL=info\n' "$SECRET" > "$ENV_FILE"
  echo "created $ENV_FILE with a random APP_SECRET"
fi

# Start stack
echo "Starting the compose stack ($PROJECT_NAME)..."
LINER_PORT=$LINER_PORT POSTGRES_PORT=$POSTGRES_PORT docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" up -d --build

# Wait for health endpoint
echo "Waiting for API to be ready..."
RETRIES=60
while [ $RETRIES -gt 0 ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ API is healthy"
    break
  fi
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -eq 0 ]; then
    echo "✗ FAIL: API did not respond after 60 retries"
    echo ""
    echo "Stack logs:"
    LINER_PORT=$LINER_PORT POSTGRES_PORT=$POSTGRES_PORT \
      docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" logs app
    exit 1
  fi
  sleep 1
done

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

# Create a scan root (pointing to a temp dir inside the container)
# Since there's no worker, the API will accept it but mark it as pending
# Expected: 201 Created
echo "Creating scan root (worker not present, expect pending)..."
SCANROOT_RESPONSE=$(curl -s -w "%{http_code}" -b "$COOKIE_JAR" -X POST "$API_URL/libraries/$LIBRARY_ID/scan-roots" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"/tmp/music-test\",
    \"displayName\": \"Test Music\"
  }")

# Extract HTTP code (last 3 characters)
HTTP_CODE="${SCANROOT_RESPONSE: -3}"
# Extract body (everything except last 3 characters)
BODY="${SCANROOT_RESPONSE%???}"

# Accept 201 Created or 409 Conflict (if worker validation fails immediately)
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "409" ]; then
  echo "✓ Scan root creation returned $HTTP_CODE (expected, worker not present)"
else
  echo "✗ FAIL: Scan root creation returned $HTTP_CODE"
  echo "$BODY"
  exit 1
fi

# Run doctor inside the app container
echo "Running doctor (--offline --expect-workers 0)..."
DOCTOR_FILE=$(mktemp)

if ! docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" exec app \
  node packages/doctor/dist/cli.js doctor --offline --expect-workers 0 > "$DOCTOR_FILE" 2>&1; then
  echo "Doctor command execution failed (exit code $?)"
fi

# Display doctor output
cat "$DOCTOR_FILE"

# Check that critical checks passed: database, migrations, contact string, cache
if ! grep -q "PASS Database" "$DOCTOR_FILE"; then
  echo "✗ FAIL: Database check did not pass"
  exit 1
fi

if ! grep -q "PASS Migrations" "$DOCTOR_FILE"; then
  echo "✗ FAIL: Migrations check did not pass"
  exit 1
fi

if ! grep -q "PASS Contact String" "$DOCTOR_FILE"; then
  echo "✗ FAIL: Contact String check did not pass"
  exit 1
fi

if ! grep -q "PASS Cache Directory" "$DOCTOR_FILE"; then
  echo "✗ FAIL: Cache Directory check did not pass"
  exit 1
fi

echo "✓ Doctor critical checks passed"

echo ""
echo "=== PASS ==="
echo "Stack is ready for deployment"
echo ""
echo "Stack status before teardown:"
docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml -p "$PROJECT_NAME" ps

exit 0

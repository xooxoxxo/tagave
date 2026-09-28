#!/usr/bin/env bash
# Runs install-tagave.sh --yes --no-start for each role against the deploy/
# files in this checkout, and checks what it writes: compose accepts the
# configuration, the secrets files are private, a split install's two halves
# agree, and the published database listens where it was told to.
#
# Needs Docker with Compose v2. Starts nothing and pulls nothing.
#
# usage: scripts/test-installer.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo/install-tagave.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/tagave-installer-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() { printf 'test-installer: FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'test-installer: ok   %s\n' "$*"; }

mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

env_value() { grep -E "^$1=" "$2" | tail -n 1 | cut -d= -f2- | sed "s/^'//; s/'\$//"; }

# An address of this computer for the split install's database to listen on.
address="$( { ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1; \
              ifconfig 2>/dev/null | awk '$1 == "inet" {sub("addr:", "", $2); print $2}'; } \
            | grep -v '^127\.' | head -n 1 || true)"
[ -n "$address" ] || fail "could not find a non-loopback IPv4 address on this computer"

run() {
  TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" --yes --no-start --version edge --timezone UTC "$@" </dev/null
}

render() { (cd "$1" && docker compose config --format json); }
services() { (cd "$1" && docker compose config --services | sort | tr '\n' ' '); }

mkdir -p "$work/music"

# --- role all -----------------------------------------------------------------
run --role all --dir "$work/all" --music "$work/music" >"$work/all.log" 2>&1 \
  || { cat "$work/all.log" >&2; fail "role all"; }
[ "$(mode_of "$work/all/.env")" = "600" ] || fail "role all: .env is not mode 600"
[ "$(env_value COMPOSE_PROFILES "$work/all/.env")" = "app,files" ] || fail "role all: profiles"
secret="$(env_value APP_SECRET "$work/all/.env")"
[ "${#secret}" -ge 40 ] || fail "role all: APP_SECRET looks too short"
config="$(render "$work/all")"
[ "$(services "$work/all")" = "app postgres worker-files worker-identify " ] || fail "role all: services are $(services "$work/all")"
printf '%s' "$config" | grep -q '"NODE_ENV": "production"' || fail "role all: app lacks NODE_ENV=production"
printf '%s' "$config" | grep -q '"published": "5432"' && fail "role all: postgres must not be published"
pass "role all"

# Re-running keeps the secrets.
run --role all --dir "$work/all" --music "$work/music" >"$work/all2.log" 2>&1 \
  || { cat "$work/all2.log" >&2; fail "role all, second run"; }
[ "$(env_value APP_SECRET "$work/all/.env")" = "$secret" ] || fail "role all: re-run replaced APP_SECRET"
pass "role all, re-run keeps secrets"

# --- role app -----------------------------------------------------------------
run --role app --dir "$work/app" --advertise-address "$address" >"$work/app.log" 2>&1 \
  || { cat "$work/app.log" >&2; fail "role app"; }
[ "$(mode_of "$work/app/.env")" = "600" ] || fail "role app: .env is not mode 600"
[ "$(mode_of "$work/app/files-worker.env")" = "600" ] || fail "role app: files-worker.env is not mode 600"
[ "$(env_value DB_BIND "$work/app/.env")" = "$address" ] || fail "role app: DB_BIND should default to the advertise address"
config="$(render "$work/app")"
printf '%s' "$config" | grep -q "\"host_ip\": \"$address\"" || fail "role app: postgres is not bound to $address"
[ "$(services "$work/app")" = "app postgres worker-identify " ] || fail "role app: services are $(services "$work/app")"
pass "role app"

# Without an address of this computer, --yes must refuse rather than open 0.0.0.0.
if run --role app --dir "$work/app-bad" --advertise-address 203.0.113.9 >"$work/app-bad.log" 2>&1; then
  fail "role app: accepted an advertise address that is not on this computer without --db-bind"
fi
pass "role app refuses to guess a bind address"

# --- role files ---------------------------------------------------------------
run --role files --dir "$work/files" --from "$work/app/files-worker.env" --music "$work/music" >"$work/files.log" 2>&1 \
  || { cat "$work/files.log" >&2; fail "role files"; }
[ "$(mode_of "$work/files/.env")" = "600" ] || fail "role files: .env is not mode 600"
for key in APP_SECRET POSTGRES_PASSWORD; do
  [ "$(env_value "$key" "$work/files/.env")" = "$(env_value "$key" "$work/app/.env")" ] \
    || fail "role files: $key differs from the app computer's"
done
[ "$(env_value DB_HOST "$work/files/.env")" = "$address" ] || fail "role files: DB_HOST"
config="$(render "$work/files")"
[ "$(services "$work/files")" = "worker-files " ] || fail "role files: services are $(services "$work/files")"
printf '%s' "$config" | grep -q "@$address:5432/" || fail "role files: DATABASE_URL does not point at the app computer"
pass "role files"

echo "test-installer: all roles pass"

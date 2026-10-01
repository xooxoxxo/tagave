#!/usr/bin/env bash
# Runs install-tagave.sh --yes --no-start for each role against the deploy/
# files in this checkout, and checks what it writes: compose accepts the
# configuration, the secrets files are private, a split install's two halves
# agree, and the published database listens where it was told to.
#
# Then checks version pinning against a fake releases feed, and runs
# "update" and "status" against a stand-in docker that logs every call:
# backup before anything changes, app restarted before the workers, roll back
# printed, downgrades refused, and the music computer following the app.
#
# Needs Docker with Compose v2 (only "docker compose config" runs for real).
# Starts nothing and pulls nothing.
#
# usage: scripts/test-installer.sh        (TAGAVE_TEST_KEEP=1 keeps the temp folder)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo/install-tagave.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/tagave-installer-test.XXXXXX")"
trap '[ "${TAGAVE_TEST_KEEP:-0}" = 1 ] && echo "kept $work" || rm -rf "$work"' EXIT

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
[ -x "$work/all/install-tagave.sh" ] || fail "role all: no copy of the installer in the install folder"
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

# --- version pinning ----------------------------------------------------------
# A fake GitHub releases API: install-tagave.sh reads $TAGAVE_RELEASES_API/latest.
mkdir -p "$work/releases"
printf '{\n  "tag_name": "v0.5.0",\n  "name": "0.5.0"\n}\n' >"$work/releases/latest"
releases="file://$work/releases"

# A registry no local image comes from, so the re-run below cannot read a
# version off an image this computer happens to have.
export TAGAVE_REGISTRY=example.invalid/tagave-test
TAGAVE_SKIP_IMAGE_CHECK=1 TAGAVE_RELEASES_API="$releases" "$installer" --yes --no-start --timezone UTC \
  --role all --dir "$work/pin" --music "$work/music" >"$work/pin.log" 2>&1 </dev/null \
  || { cat "$work/pin.log" >&2; fail "pinning"; }
[ "$(env_value TAGAVE_VERSION "$work/pin/.env")" = "0.5.0" ] \
  || fail "pinning: .env holds TAGAVE_VERSION=$(env_value TAGAVE_VERSION "$work/pin/.env"), not the release number"
# An .env from an older installer holds the floating 'latest'; a re-run pins it.
sed 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=latest/' "$work/pin/.env" >"$work/pin/.env.new" && mv "$work/pin/.env.new" "$work/pin/.env"
TAGAVE_SKIP_IMAGE_CHECK=1 TAGAVE_RELEASES_API="$releases" "$installer" --yes --no-start \
  --dir "$work/pin" >"$work/pin2.log" 2>&1 </dev/null \
  || { cat "$work/pin2.log" >&2; fail "pinning, re-run"; }
[ "$(env_value TAGAVE_VERSION "$work/pin/.env")" = "0.5.0" ] || fail "pinning: re-run left TAGAVE_VERSION=latest"
unset TAGAVE_REGISTRY
pass "installer pins the newest release number, and re-pins 'latest' when nothing runs"

# --- update and status, against a stand-in docker -----------------------------
# The stand-in answers what the installer asks, logs every call, keeps the
# running version in a file, and hands `compose config` to the real docker.
real_docker="$(command -v docker)"
mkdir -p "$work/bin" "$work/state"
cat >"$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  info) exit 0 ;;
  version) echo 27.0.0; exit 0 ;;
  manifest) echo '{"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'; exit 0 ;;
  inspect)
    case "$*" in
      *Config.Env*) [ "${FAKE_APP_DOWN:-0}" = "1" ] || printf 'NODE_ENV=production\nLINER_VERSION=%s\n' "$(cat "$FAKE_STATE/version")" ;;
      *) echo healthy ;;
    esac
    exit 0 ;;
  volume) exit 1 ;;
  compose) shift ;;
  *) exit 0 ;;
esac
case "$1" in
  version) echo 2.29.0 ;;
  config) exec "$REAL_DOCKER" compose "$@" ;;
  ps) if [ "${2:-}" = "--format" ]; then printf 'SERVICE STATE STATUS\napp running Up\n'; else echo fakeid; fi ;;
  logs) echo '{"msg":"worker ready"}' ;;
  up)
    if [ "$*" != "up -d postgres" ] && [ "${FAKE_UP_KEEPS_OLD:-0}" != "1" ]; then
      grep '^TAGAVE_VERSION=' .env | cut -d= -f2 | tr -d '\n' >"$FAKE_STATE/version"
    fi ;;
  exec)
    case "$*" in
      *" app node "*) [ "${FAKE_APP_DOWN:-0}" = "1" ] || printf '%s ok ok ok pass\n' "$(cat "$FAKE_STATE/version")" ;;
      *psql*) cat >/dev/null; echo "${FAKE_FILE_WORKERS:-0}" ;;
      *pg_dump*) printf 'PGDMP fake dump' ;;
      *"pg_restore --list"*) cat >/dev/null; printf ';\n; Archive\n215; 1259 16385 TABLE public albums liner\n' ;;
    esac ;;
esac
exit 0
FAKE
chmod +x "$work/bin/docker"

fake() {
  PATH="$work/bin:$PATH" REAL_DOCKER="$real_docker" FAKE_LOG="$work/docker.log" FAKE_STATE="$work/state" \
    TAGAVE_RELEASES_API="$releases" "$installer" "$@" </dev/null
}
at_version() {
  TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" --yes --no-start --version "$1" --timezone UTC "${@:2}" </dev/null
}
# line_of PATTERN: first line of the docker log matching PATTERN exactly.
line_of() { grep -nx -- "$1" "$work/docker.log" | head -n 1 | cut -d: -f1; }

at_version 0.4.1 --role all --dir "$work/upd" --music "$work/music" >"$work/upd-install.log" 2>&1 \
  || { cat "$work/upd-install.log" >&2; fail "update: install 0.4.1"; }
printf '0.4.1' >"$work/state/version"

fake status --dir "$work/upd" >"$work/status.log" 2>&1 || { cat "$work/status.log" >&2; fail "status"; }
grep -q 'Running now: *0.4.1' "$work/status.log" || fail "status: does not show the running version"
grep -q 'tagave 0.5.0 is out' "$work/status.log" || fail "status: does not offer 0.5.0"
pass "status shows the running version and the newer release"

fake update --dir "$work/upd" --dry-run >"$work/dry.log" 2>&1 || { cat "$work/dry.log" >&2; fail "update --dry-run"; }
grep -q 'Dry run: nothing changed' "$work/dry.log" || fail "update --dry-run: no dry-run notice"
grep -q "releases/tag/v0.5.0" "$work/dry.log" || fail "update --dry-run: no release notes link"
[ "$(env_value TAGAVE_VERSION "$work/upd/.env")" = "0.4.1" ] || fail "update --dry-run changed .env"
[ ! -d "$work/upd/backups" ] || fail "update --dry-run wrote a backup"
pass "update --dry-run changes nothing"

: >"$work/docker.log"
fake update --dir "$work/upd" --yes >"$work/update.log" 2>&1 || { cat "$work/update.log" >&2; fail "update"; }
[ "$(env_value TAGAVE_VERSION "$work/upd/.env")" = "0.5.0" ] || fail "update: .env not moved to 0.5.0"
backup="$(find "$work/upd/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-0.4.1-*' | head -n 1)"
[ -n "$backup" ] || fail "update: no pre-update-0.4.1 backup folder"
[ -s "$backup/database.pgdump" ] || fail "update: no database dump in $backup"
[ "$(env_value TAGAVE_VERSION "$backup/.env")" = "0.4.1" ] || fail "update: the saved .env is not the 0.4.1 one"
[ "$(mode_of "$backup")" = "700" ] || fail "update: the backup folder is not private"
dump_at="$(grep -n 'pg_dump' "$work/docker.log" | head -n 1 | cut -d: -f1)"
stop_at="$(line_of 'compose stop worker-files worker-identify')"
[ -n "$stop_at" ] || stop_at="$(line_of 'compose stop worker-identify worker-files')"
app_at="$(line_of 'compose up -d app')"
rest_at="$(line_of 'compose up -d')"
[ -n "$dump_at" ] && [ -n "$stop_at" ] && [ -n "$app_at" ] && [ -n "$rest_at" ] \
  || { cat "$work/docker.log" >&2; fail "update: missing backup, stop or start calls"; }
[ "$dump_at" -lt "$stop_at" ] && [ "$stop_at" -lt "$app_at" ] && [ "$app_at" -lt "$rest_at" ] \
  || { cat "$work/docker.log" >&2; fail "update: expected backup, stop workers, start app, then the rest"; }
grep -q 'How to roll back to 0.4.1' "$work/update.log" || fail "update: no roll back instructions"
grep -q 'pg_restore' "$work/update.log" || fail "update: roll back does not restore the database"
pass "update backs up, pins 0.5.0, restarts the app before the workers, prints the roll back"

fake update --dir "$work/upd" --yes >"$work/update2.log" 2>&1 || { cat "$work/update2.log" >&2; fail "update, again"; }
grep -q 'Already on 0.5.0' "$work/update2.log" || fail "update: a second run should do nothing"
if fake update --dir "$work/upd" --version 0.4.1 --yes >"$work/down.log" 2>&1; then
  fail "update: accepted a downgrade"
fi
grep -q 'older than 0.5.0' "$work/down.log" || fail "update: downgrade refused without saying why"
pass "update is a no-op when current, refuses to go back"

# A new version that never reports healthy: update fails and says how to go back.
at_version 0.4.1 --role all --dir "$work/upd-bad" --music "$work/music" >"$work/bad-install.log" 2>&1 \
  || { cat "$work/bad-install.log" >&2; fail "update failure: install 0.4.1"; }
printf '0.4.1' >"$work/state/version"
if FAKE_UP_KEEPS_OLD=1 TAGAVE_HEALTH_TIMEOUT=0 fake update --dir "$work/upd-bad" --yes >"$work/bad.log" 2>&1; then
  fail "update: reported success although the app never ran 0.5.0"
fi
grep -q 'How to roll back to 0.4.1' "$work/bad.log" || { cat "$work/bad.log" >&2; fail "update failure: no roll back instructions"; }
grep -q 'dropdb' "$work/bad.log" || fail "update failure: roll back does not reset the database"
pass "a failed update prints how to roll back"

# Split install: the file worker follows the app computer's version.
at_version 0.4.1 --role app --dir "$work/split-app" --advertise-address "$address" >"$work/split-app.log" 2>&1 \
  || { cat "$work/split-app.log" >&2; fail "split update: app install"; }
[ -n "$(env_value TAGAVE_APP_URL "$work/split-app/files-worker.env")" ] || fail "split: files-worker.env has no TAGAVE_APP_URL"
at_version 0.4.1 --role files --dir "$work/split-files" --from "$work/split-app/files-worker.env" --music "$work/music" \
  >"$work/split-files.log" 2>&1 || { cat "$work/split-files.log" >&2; fail "split update: files install"; }
[ "$(env_value TAGAVE_APP_URL "$work/split-files/.env")" = "http://$address:3100" ] || fail "split: files .env has no TAGAVE_APP_URL"
mkdir -p "$work/appsrv/api/v1"
printf '{"version":"0.5.0","sha":"abc"}' >"$work/appsrv/api/v1/version"
printf '{"status":"ok","checks":[{"id":"versions","title":"Build Versions","status":"pass","detail":"x"}]}' >"$work/appsrv/api/v1/health"
if fake update --dir "$work/split-files" --app-url "file://$work/appsrv" --version 0.6.0 --yes >"$work/split-mismatch.log" 2>&1; then
  fail "split update: accepted a version the app computer does not run"
fi
grep -q 'app computer runs 0.5.0' "$work/split-mismatch.log" || fail "split update: mismatch refused without saying why"
: >"$work/docker.log"
fake update --dir "$work/split-files" --app-url "file://$work/appsrv" --yes >"$work/split-update.log" 2>&1 \
  || { cat "$work/split-update.log" >&2; fail "split update"; }
[ "$(env_value TAGAVE_VERSION "$work/split-files/.env")" = "0.5.0" ] || fail "split update: .env not moved to 0.5.0"
grep -q 'pg_dump' "$work/docker.log" && fail "split update: the music computer has no database to back up"
grep -q 'same build' "$work/split-update.log" || fail "split update: did not confirm matching builds"
pass "update on the music computer follows the app computer"

# An app computer warns while the music computer's file worker still checks in.
printf '0.4.1' >"$work/state/version"
FAKE_FILE_WORKERS=1 fake update --dir "$work/split-app" --dry-run >"$work/split-live.log" 2>&1 \
  || { cat "$work/split-live.log" >&2; fail "split update: dry run with a live file worker"; }
grep -q 'on the music computer: docker compose stop worker-files' "$work/split-live.log" \
  || fail "split update: the plan does not say to stop the file worker first"
grep -q 'file worker on the music computer is still running' "$work/split-live.log" \
  || fail "split update: no warning while the file worker still runs"
FAKE_FILE_WORKERS=0 fake update --dir "$work/split-app" --dry-run >"$work/split-quiet.log" 2>&1 \
  || { cat "$work/split-quiet.log" >&2; fail "split update: dry run without a file worker"; }
grep -q 'still running' "$work/split-quiet.log" && fail "split update: warned although no file worker checks in"
pass "update on the app computer asks to stop the file worker first"

# --- an .env from an older installer: TAGAVE_VERSION=latest ------------------
float_env() { sed 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=latest/' "$work/float/.env" >"$work/float/.env.new" && mv "$work/float/.env.new" "$work/float/.env"; }
at_version 0.4.1 --role all --dir "$work/float" --music "$work/music" >"$work/float-install.log" 2>&1 \
  || { cat "$work/float-install.log" >&2; fail "latest: install"; }
printf '0.4.1' >"$work/state/version"
float_env

# Re-running the installer pins the version that runs, not the newest release.
TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --no-start --dir "$work/float" >"$work/float-rerun.log" 2>&1 \
  || { cat "$work/float-rerun.log" >&2; fail "latest: installer re-run"; }
[ "$(env_value TAGAVE_VERSION "$work/float/.env")" = "0.4.1" ] \
  || fail "latest: installer re-run pinned $(env_value TAGAVE_VERSION "$work/float/.env"), not the running 0.4.1"
pass "re-running the installer on 'latest' pins the running version"

# update treats the running version as the one to roll back to.
float_env
: >"$work/docker.log"
fake update --dir "$work/float" --yes >"$work/float-update.log" 2>&1 \
  || { cat "$work/float-update.log" >&2; fail "latest: update"; }
[ "$(env_value TAGAVE_VERSION "$work/float/.env")" = "0.5.0" ] || fail "latest: update did not pin 0.5.0"
backup="$(find "$work/float/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-0.4.1-*' | head -n 1)"
[ -n "$backup" ] || fail "latest: backup folder is not named after the running 0.4.1"
[ "$(env_value TAGAVE_VERSION "$backup/.env")" = "0.4.1" ] \
  || fail "latest: the saved .env says $(env_value TAGAVE_VERSION "$backup/.env"); a roll back would pull the newest release"
grep -q 'How to roll back to 0.4.1' "$work/float-update.log" || fail "latest: roll back does not name 0.4.1"
pass "update on 'latest' backs up and rolls back to the running version"

# A downgrade below the running version is refused although .env floats.
float_env
if fake update --dir "$work/float" --version 0.4.0 --yes >"$work/float-down.log" 2>&1; then
  fail "latest: accepted a downgrade below the running 0.5.0"
fi
grep -q 'older than 0.5.0' "$work/float-down.log" || { cat "$work/float-down.log" >&2; fail "latest: downgrade refused without saying why"; }
[ "$(env_value TAGAVE_VERSION "$work/float/.env")" = "latest" ] || fail "latest: a refused downgrade changed .env"
pass "update on 'latest' refuses to go below the running version"

# Nothing names the running version: refuse without --yes.
if FAKE_APP_DOWN=1 fake update --dir "$work/float" >"$work/float-unknown.log" 2>&1; then
  fail "latest: updated without knowing the running version"
fi
grep -q 'Cannot tell which version runs here' "$work/float-unknown.log" \
  || { cat "$work/float-unknown.log" >&2; fail "latest: unknown version refused without saying why"; }
pass "update refuses without --yes when the running version is unknown"

echo "test-installer: all roles pass"

#!/usr/bin/env bash
# offline-share-test.sh - the music share layout on a real NFS mount.
#
# The Linux integration test of the offline library (the CI job
# "offline-share"). It exports a temp folder of small FLACs over NFS from this
# computer, mounts it `hard`, installs tagave with the parent layout
# (TAGAVE_MUSIC_MODE=rw: the parent layout is only for writable installs) and
# then plays the NAS going away with an iptables rule that drops port 2049:
#
#   1. setup: the export, the hard mount, a parent layout .env, a first scan
#   2. NAS off at create: worker-files and the player run within 60 s, the API
#      says the folder is offline within 2 minutes
#   3. NAS off while running: the heartbeat stays fresh, the scan parks, no
#      file is marked missing, a Tag Plan applied during the outage waits and
#      applies once the rule is gone, with the audio unchanged
#   4. mounted later: the share mounted after the stack started is seen inside
#      worker-files (and the player) without a restart, and a scan finds it
#   5. direct layout: an old .env (no layout keys) renders the old bind
#   6. cleanup on any exit (trap): only what this run made
#
# Needs Linux, root (run it with sudo -E), nfs-kernel-server running, flac
# (flac and metaflac), iptables, python3, curl, openssl, Docker with compose.
# It changes the firewall, the NFS exports and the mount table of the
# computer it runs on, so it refuses to run unless CI=true or
# OFFLINETEST_ALLOW=1. NEVER run it on a developer Mac (it refuses Darwin).
#
# Environment:
#   OFFLINETEST_IMAGE_TAG     tag of prebuilt images
#                             $OFFLINETEST_REGISTRY/tagave-{app,worker}:<tag>;
#                             unset: this script builds them as
#                             offlinetest/tagave-{app,worker}:offlinetest-<id>
#                             and removes them at the end
#   OFFLINETEST_REGISTRY      image name prefix (default: offlinetest)
#   OFFLINETEST_REMOVE_IMAGES 1: also remove the prebuilt images named above
#   OFFLINETEST_NFS_HOST      the address the share is exported and mounted on
#                             (default: this computer's primary IPv4 address)
#   OFFLINETEST_PORT          the app's port (default 3197)
#   OFFLINETEST_PLAYER_PORT   the player's port (default 4597)
#
# Why not 127.0.0.1 for the share: the file worker asks the share's server on
# its port from inside its container, where 127.0.0.1 is the container
# itself. The primary address is local to this computer too, so the INPUT
# rule still stands for the NAS going off.
#
# Everything it makes is named offlinetest-<id>: the compose project (its
# containers, network and volumes), the folder ${TMPDIR:-/tmp}/offlinetest-<id>,
# the export file /etc/exports.d/offlinetest-<id>.exports. It never runs
# docker system prune; postgres:16 and the Navidrome image it pulls are kept.

# The checks run through `check` and `wait_until`, which shellcheck does not follow.
# shellcheck disable=SC2329
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)

# ---------------------------------------------------------------- guards

if [ "$(uname -s)" != "Linux" ]; then
  echo "offline-share-test: Linux only (it uses iptables, NFS and mount); never run it on a Mac" >&2
  exit 2
fi
if [ "${CI:-}" != "true" ] && [ "${OFFLINETEST_ALLOW:-}" != "1" ]; then
  echo "offline-share-test: it changes the firewall, NFS exports and mounts of this computer; set OFFLINETEST_ALLOW=1 to run it outside CI" >&2
  exit 2
fi
if [ "$(id -u)" != "0" ]; then
  echo "offline-share-test: run it as root: sudo -E $0" >&2
  exit 2
fi
for tool in docker iptables exportfs mount umount mountpoint flac metaflac md5sum python3 curl openssl ip timeout; do
  command -v "$tool" >/dev/null 2>&1 || { echo "offline-share-test: $tool is missing" >&2; exit 2; }
done
docker compose version >/dev/null 2>&1 || { echo "offline-share-test: docker compose is missing" >&2; exit 2; }
[ -d /etc/exports.d ] || { echo "offline-share-test: /etc/exports.d is missing (install nfs-kernel-server)" >&2; exit 2; }

# ---------------------------------------------------------------- names

ID=$(openssl rand -hex 2)
PROJECT="offlinetest-$ID"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_BASE%/}/$PROJECT"
EXPORT="$TMP_ROOT/export"
MNT="$TMP_ROOT/mnt"
MUSIC="$MNT/music"
INSTALL="$TMP_ROOT/install"
OLD="$TMP_ROOT/old"
EXPORTS_FILE="/etc/exports.d/$PROJECT.exports"
JAR="$TMP_ROOT/cookies"
PORT="${OFFLINETEST_PORT:-3197}"
PLAYER_PORT="${OFFLINETEST_PLAYER_PORT:-4597}"
PUBLIC_URL="http://localhost:$PORT"
API="$PUBLIC_URL/api/v1"
REGISTRY="${OFFLINETEST_REGISTRY:-offlinetest}"
IMAGE_TAG="${OFFLINETEST_IMAGE_TAG:-}"
NFS_HOST="${OFFLINETEST_NFS_HOST:-$(ip -4 -o route get 192.0.2.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
[ -n "$NFS_HOST" ] || { echo "offline-share-test: no primary IPv4 address; set OFFLINETEST_NFS_HOST" >&2; exit 2; }

ALBUM_DIR="Robin/Offline Test"
TRACKS=3
OWNER_EMAIL="robin@example.com"
OWNER_PASSWORD="Offline-Test-$(openssl rand -hex 8)"
GENRE="Offline Test"

# what this run made, for the trap and the report
RULES_ADDED=0
MADE_TMP=0
MADE_EXPORT=0
MADE_MOUNT=0
MADE_STACK=0
BUILT_IMAGES=()
REMOVE_IMAGES=()
FAILS=0
CREATED=()
REMOVED=()
LEFT=()

# ---------------------------------------------------------------- output

ok() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
note() { echo "     $*"; }
step() { echo ""; echo "=== $* ==="; }

# check LABEL COMMAND...: ok or FAIL by the command's exit status
check() {
  local label=$1
  shift
  if "$@"; then ok "$label"; else fail "$label"; fi
}

# wait_until SECONDS COMMAND...: polls every 2 s until COMMAND succeeds
wait_until() {
  local secs=$1 start=$SECONDS
  shift
  until "$@" >/dev/null 2>&1; do
    [ $((SECONDS - start)) -lt "$secs" ] || return 1
    sleep 2
  done
}

# ---------------------------------------------------------------- helpers

# an array too, so `timeout` (which cannot run a shell function) can run it
COMPOSE=(docker compose --project-directory "$INSTALL" -f "$INSTALL/compose.yml" --env-file "$INSTALL/.env" -p "$PROJECT")
compose() { "${COMPOSE[@]}" "$@"; }

psql_q() {
  compose exec -T postgres psql -q -U tagave -d tagave -Atc "$1"
}

# api METHOD PATH [JSON]: the body on stdout, the status in $TMP_ROOT/status
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -o "$TMP_ROOT/body" -w '%{http_code}' -b "$JAR" -c "$JAR" -H "Origin: $PUBLIC_URL" -X "$method")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  rm -f "$TMP_ROOT/body"
  curl "${args[@]}" "$API$path" >"$TMP_ROOT/status" 2>/dev/null || echo 000 >"$TMP_ROOT/status"
  cat "$TMP_ROOT/body" 2>/dev/null || true
}
api_status() { cat "$TMP_ROOT/status"; }

# jget PATH: a field of the JSON on stdin (a.b.0.c), empty when absent
jget() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for k in sys.argv[1].split("."):
    if isinstance(d, list) and k.isdigit() and int(k) < len(d):
        d = d[int(k)]
    elif isinstance(d, dict):
        d = d.get(k)
    else:
        d = None
    if d is None:
        break
if d is None:
    print("")
elif isinstance(d, bool):
    print("true" if d else "false")
elif isinstance(d, (dict, list)):
    print(json.dumps(d))
else:
    print(d)
' "$1"
}

container_of() { compose ps -a -q "$1" 2>/dev/null | head -n 1; }
state_of() {
  local c
  c=$(container_of "$1")
  [ -n "$c" ] || { echo none; return; }
  docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo none
}
is_running() { [ "$(state_of "$1")" = "running" ]; }
both_running() { is_running worker-files && is_running player; }

app_healthy() { curl -fsS "$API/health" >/dev/null 2>&1; }

login() {
  api POST /auth/login "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" >/dev/null
  [ "$(api_status)" = "200" ]
}

folder_kind() { api GET /system/music-folder | jget kind; }
folder_is() { [ "$(folder_kind)" = "$1" ]; }

drop_nfs() {
  iptables -I INPUT -p tcp --dport 2049 -j DROP
  RULES_ADDED=$((RULES_ADDED + 1))
  note "iptables: INPUT tcp dport 2049 DROP added (the NAS is off)"
}
restore_nfs() {
  while [ "$RULES_ADDED" -gt 0 ]; do
    iptables -D INPUT -p tcp --dport 2049 -j DROP || return 1
    RULES_ADDED=$((RULES_ADDED - 1))
    note "iptables: the DROP rule removed (the NAS is back)"
  done
}

mount_share() {
  # noac is for this test only: without the attribute cache every walk asks
  # the server, so a scan during the outage cannot finish from the cache.
  mount -t nfs -o vers=4.2,hard,timeo=50,noac "$NFS_HOST:$EXPORT" "$MUSIC"
  MADE_MOUNT=1
}

present_files() { psql_q "select count(*) from files where scan_root_id = '$ROOT_ID' and status = 'present'"; }
not_present_files() { psql_q "select count(*) from files where scan_root_id = '$ROOT_ID' and (status <> 'present' or missing_held_at is not null)"; }
latest_scan_status() { psql_q "select status from scans where scan_root_id = '$ROOT_ID' order by started_at desc limit 1"; }

scan_done_with_files() {
  [ "$(present_files)" = "$TRACKS" ] && [ "$(latest_scan_status)" = "completed" ]
}

start_scan() {
  api POST "/libraries/$LIB_ID/scan-roots/$ROOT_ID/scan" '{"mode":"full"}' >/dev/null
  case "$(api_status)" in 2??) return 0 ;; *) return 1 ;; esac
}

# audio_md5s: the MD5 of every fixture's decoded audio (not the STREAMINFO
# field, which a tag write could leave as it was over changed audio), read on
# the export side (local disk, never through the mount)
audio_md5s() {
  local f h
  for f in "$EXPORT/$ALBUM_DIR"/*.flac; do
    # A file that does not decode gets a value no other call can give, so a
    # before and after that both fail never match.
    h="$(set -o pipefail; flac -d -c -s "$f" | md5sum | cut -d' ' -f1)" || h="not-decodable-$RANDOM$RANDOM"
    printf '%s %s\n' "$(basename "$f")" "$h"
  done
}

genres_written() {
  local f
  for f in "$EXPORT/$ALBUM_DIR"/*.flac; do
    [ "$(metaflac --show-tag=GENRE "$f" | sed 's/^GENRE=//')" = "$GENRE" ] || return 1
  done
}

plan_status() { api GET "/libraries/$LIB_ID/tag-plans/$PLAN_ID" | jget status; }
plan_is() { [ "$(plan_status)" = "$1" ]; }

# ---------------------------------------------------------------- cleanup

cleanup() {
  local status=$?
  set +e
  trap - EXIT
  echo ""
  echo "=== cleanup ==="
  if [ "$status" -ne 0 ] || [ "$FAILS" -gt 0 ]; then
    if [ "$MADE_STACK" = "1" ]; then
      echo "--- last log lines (app, worker-files, player) ---"
      compose logs --no-color --tail 80 app worker-files player 2>&1 | tail -n 240
    fi
  fi
  # the rule first: a container stuck on the dead share cannot stop
  if [ "$RULES_ADDED" -gt 0 ]; then
    if restore_nfs; then REMOVED+=("iptables rule INPUT tcp dport 2049 DROP"); else LEFT+=("iptables rule INPUT tcp dport 2049 DROP ($RULES_ADDED)"); fi
  fi
  if [ "$MADE_STACK" = "1" ]; then
    if timeout 120 "${COMPOSE[@]}" down -v --remove-orphans --timeout 20; then
      REMOVED+=("compose project $PROJECT (containers, network ${PROJECT}_default, ${PROJECT}_updater, volumes ${PROJECT}_pgdata, ${PROJECT}_cache, ${PROJECT}_backups, ${PROJECT}_player-data)")
    else
      LEFT+=("compose project $PROJECT")
    fi
  fi
  if [ "$MADE_MOUNT" = "1" ] || mountpoint -q "$MUSIC" 2>/dev/null; then
    if mountpoint -q "$MUSIC" 2>/dev/null; then umount -f -l "$MUSIC"; fi
    if mountpoint -q "$MUSIC" 2>/dev/null; then LEFT+=("mount $MUSIC"); else REMOVED+=("mount $MUSIC"); fi
  fi
  if [ "$MADE_EXPORT" = "1" ]; then
    rm -f "$EXPORTS_FILE"
    exportfs -ra
    if [ -e "$EXPORTS_FILE" ]; then LEFT+=("export $EXPORTS_FILE"); else REMOVED+=("export $EXPORTS_FILE (exportfs -ra)"); fi
  fi
  local img
  for img in "${BUILT_IMAGES[@]}" "${REMOVE_IMAGES[@]}"; do
    [ -n "$img" ] || continue
    if docker image rm "$img" >/dev/null 2>&1; then REMOVED+=("image $img"); else LEFT+=("image $img"); fi
  done
  if [ "$MADE_TMP" = "1" ]; then
    case "$TMP_ROOT" in
      */offlinetest-[0-9a-f][0-9a-f][0-9a-f][0-9a-f])
        if mountpoint -q "$MUSIC" 2>/dev/null; then
          LEFT+=("folder $TMP_ROOT (the share is still mounted in it)")
        else
          rm -rf -- "$TMP_ROOT"
          if [ -e "$TMP_ROOT" ]; then LEFT+=("folder $TMP_ROOT"); else REMOVED+=("folder $TMP_ROOT"); fi
        fi
        ;;
      *) LEFT+=("folder $TMP_ROOT (unexpected name, not removed)") ;;
    esac
  fi
  echo "created:"
  local x
  for x in "${CREATED[@]}"; do echo "  $x"; done
  echo "removed:"
  for x in "${REMOVED[@]}"; do echo "  $x"; done
  if [ "${#LEFT[@]}" -gt 0 ]; then
    echo "left behind (remove by hand):"
    for x in "${LEFT[@]}"; do echo "  $x"; done
    [ "$status" -ne 0 ] || status=1
  fi
  if [ "$FAILS" -gt 0 ]; then
    echo ""
    echo "=== $FAILS check(s) FAILED ==="
    [ "$status" -ne 0 ] || status=1
  elif [ "$status" -eq 0 ]; then
    echo ""
    echo "=== PASS ==="
  fi
  exit "$status"
}
trap cleanup EXIT

# ================================================================ 1. setup
step "1. setup ($PROJECT, share on $NFS_HOST)"

mkdir -m 700 "$TMP_ROOT"
MADE_TMP=1
CREATED+=("folder $TMP_ROOT")
mkdir -p "$EXPORT/$ALBUM_DIR" "$MUSIC" "$INSTALL" "$OLD"

for n in $(seq 1 "$TRACKS"); do
  wav="$TMP_ROOT/tone$n.wav"
  python3 - "$wav" "$((220 * n))" <<'PY'
import math, struct, sys, wave
path, freq, rate = sys.argv[1], float(sys.argv[2]), 44100
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(rate)))
PY
  flac="$EXPORT/$ALBUM_DIR/0$n Tone $n.flac"
  flac --silent --force -o "$flac" "$wav"
  rm -f "$wav"
  metaflac --set-tag=ARTIST=Robin --set-tag=ALBUMARTIST=Robin --set-tag="ALBUM=Offline Test" \
    --set-tag="TITLE=Tone $n" --set-tag="TRACKNUMBER=$n" --set-tag=DATE=2026 "$flac"
done
chmod -R a+rwX "$EXPORT"
ok "$TRACKS fixture FLACs in $EXPORT/$ALBUM_DIR"
MD5_BEFORE=$(audio_md5s)

printf '"%s" %s(rw,sync,no_subtree_check,no_root_squash,insecure,fsid=%s)\n' "$EXPORT" "$NFS_HOST" "$((0x$ID + 4096))" >"$EXPORTS_FILE"
MADE_EXPORT=1
CREATED+=("export $EXPORTS_FILE")
exportfs -ra
# No NFSv4 delegations on this throwaway runner: with one, the client answers
# stat and readdir from its cache while the lease lasts, so a scan right after
# the drop finishes without asking the server (seen in CI). Leases are off for
# the whole runner, which the job discards afterwards.
sysctl -q -w fs.leases-enable=0
note "fs.leases-enable=0: the NFS server grants no delegations"
mount_share
CREATED+=("mount $MUSIC (nfs $NFS_HOST:$EXPORT, hard)")
check "the share is mounted hard at $MUSIC" grep -q " $MUSIC nfs4 .*hard" /proc/mounts
check "the fixtures are seen through the mount" test "$(find "$MUSIC/$ALBUM_DIR" -name '*.flac' | wc -l)" -eq "$TRACKS"

if [ -n "$IMAGE_TAG" ]; then
  APP_IMAGE="$REGISTRY/tagave-app:$IMAGE_TAG"
  WORKER_IMAGE="$REGISTRY/tagave-worker:$IMAGE_TAG"
  docker image inspect "$APP_IMAGE" "$WORKER_IMAGE" >/dev/null
  if [ "${OFFLINETEST_REMOVE_IMAGES:-}" = "1" ]; then REMOVE_IMAGES=("$APP_IMAGE" "$WORKER_IMAGE"); fi
  note "images $APP_IMAGE, $WORKER_IMAGE (prebuilt)"
else
  IMAGE_TAG="$PROJECT"
  REGISTRY="offlinetest"
  APP_IMAGE="$REGISTRY/tagave-app:$IMAGE_TAG"
  WORKER_IMAGE="$REGISTRY/tagave-worker:$IMAGE_TAG"
  sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  version=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])' 2>/dev/null || echo 0.0.0)
  for part in app worker; do
    img="$REGISTRY/tagave-$part:$IMAGE_TAG"
    BUILT_IMAGES+=("$img")
    docker build -q -f "docker/$part.Dockerfile" -t "$img" \
      --build-arg "GIT_SHA=$sha" --build-arg "BUILT_AT=$(date -u +%FT%TZ)" --build-arg "TAGAVE_BUILD_VERSION=$version" . >/dev/null
    CREATED+=("image $img")
  done
  note "images $APP_IMAGE, $WORKER_IMAGE (built here)"
fi

cp "$REPO/deploy/compose.yml" "$INSTALL/compose.yml"
# A writable parent layout install, as install-tagave.sh --music-writable
# writes it (write_env): MUSIC_DIR and the mode, then the six layout keys.
cat >"$INSTALL/.env" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_PROFILES=app,files,player
TAGAVE_REGISTRY=$REGISTRY
TAGAVE_VERSION=$IMAGE_TAG
APP_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
TAGAVE_PORT=$PORT
PUBLIC_URL=$PUBLIC_URL
TAGAVE_UPDATE_FEED=off
TAGAVE_PLAYER_PORT=$PLAYER_PORT
TAGAVE_PLAYER_PASSWORD=$(openssl rand -hex 16)
TAGAVE_PLAYER_ENCRYPTION_KEY=$(openssl rand -hex 32)
MUSIC_DIR='$MUSIC'
TAGAVE_MUSIC_MODE=rw
TAGAVE_MUSIC_BIND_SOURCE='$MNT'
TAGAVE_MUSIC_BIND_TARGET=/mnt/.host
TAGAVE_PLAYER_BIND_TARGET=/host
TAGAVE_MUSIC_PROPAGATION=rslave
TAGAVE_MUSIC_NAME='music'
TAGAVE_PLAYER_MUSIC_FOLDER='/host/music'
EOF
chmod 600 "$INSTALL/.env"

MADE_STACK=1
CREATED+=("compose project $PROJECT")
timeout 300 "${COMPOSE[@]}" up -d
check "the app answers /health" wait_until 300 app_healthy

api POST /auth/setup "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\",\"displayName\":\"Robin\",\"contactString\":\"$OWNER_EMAIL\"}" >/dev/null
check "the owner account is made" test "$(api_status)" = "201" -o "$(api_status)" = "200"
check "the owner signs in" login
LIB_ID=$(api GET /libraries | jget data.0.id)
check "a library exists" test -n "$LIB_ID"
api PATCH "/libraries/$LIB_ID/settings" '{"tagWritesEnabled":true}' >/dev/null
check "tag writes are on for the library" test "$(api_status)" = "200"
ROOT_ID=$(api POST "/libraries/$LIB_ID/scan-roots" '{"path":"/mnt/music","displayName":"Offline Test"}' | jget id)
check "the scan root /mnt/music is made" test -n "$ROOT_ID"
root_valid() { api GET "/libraries/$LIB_ID/scan-roots" | grep -q '"validationStatus":"ok"'; }
check "worker-files validates /mnt/music through the parent bind" wait_until 120 root_valid
check "a first scan starts" start_scan
check "the first scan finds the $TRACKS fixtures" wait_until 180 scan_done_with_files
[ "$FAILS" -eq 0 ] || { echo "setup failed; the checks below need it"; exit 1; }

# a manual Tag Plan for the outage in step 3, previewed while the NAS is on
PLAN_BODY=$(printf '{"name":"Offline test","scope":{"type":"folder","dirPath":"%s","scanRootId":"%s"},"policy":{"preset":"manual","values":{"genre":["%s"]},"split":false,"organize":false}}' "$ALBUM_DIR" "$ROOT_ID" "$GENRE")
PLAN_ID=$(api POST "/libraries/$LIB_ID/tag-plans" "$PLAN_BODY" | jget id)
check "a Tag Plan is made" test -n "$PLAN_ID"
api POST "/libraries/$LIB_ID/tag-plans/$PLAN_ID/preview" >/dev/null
check "the Tag Plan is previewed" wait_until 180 plan_is previewed
plan_items() { psql_q "select count(*) from tag_plan_items where tag_plan_id = '$PLAN_ID'"; }
check "the Tag Plan has an item per fixture" test "$(plan_items)" = "$TRACKS"

# Every later step needs a working setup. Stopping here keeps a broken run
# short, so the trap prints the logs well before the job's time limit.
if [ "$FAILS" -gt 0 ]; then
  echo "FAIL setup did not finish; the later steps need it"
  exit 1
fi

# ================================================================ 2. NAS off at create
step "2. NAS off at create"

timeout 120 "${COMPOSE[@]}" down --timeout 20
drop_nfs
t0=$SECONDS
timeout 150 "${COMPOSE[@]}" up -d >"$TMP_ROOT/up.log" 2>&1 &
up_pid=$!
if wait_until 60 both_running; then
  ok "worker-files and player are running $((SECONDS - t0)) s after compose up (limit 60 s)"
else
  fail "worker-files ($(state_of worker-files)) and player ($(state_of player)) not both running within 60 s"
fi
up_rc=0
wait "$up_pid" || up_rc=$?
check "compose up -d ends with the NAS off (exit $up_rc)" test "$up_rc" -eq 0
[ "$up_rc" -eq 0 ] || cat "$TMP_ROOT/up.log"
wait_until 60 app_healthy || true
login >/dev/null 2>&1 || true
left=$((120 - (SECONDS - t0)))
[ "$left" -gt 0 ] || left=1
if wait_until "$left" folder_is offline; then
  ok "the API says offline $((SECONDS - t0)) s after compose up (limit 120 s)"
else
  fail "the API did not say offline within 120 s (it says '$(folder_kind)')"
fi
check "no file is marked missing" test "$(not_present_files)" = "0"
restore_nfs
check "the folder is online again once the rule is removed" wait_until 240 folder_is none

# ================================================================ 3. NAS off while running
step "3. NAS off while running"

# The return in step 2 queues a quick scan; a scan asked for while it is still
# queued or running would be folded into it, so wait for it to finish first.
scan_idle() { [ "$(psql_q "select count(*) from scans where scan_root_id = '$ROOT_ID' and status = 'running'")" = "0" ]; }
wait_until 60 scan_idle || note "a scan is still running before the drop"
t_scan=$(psql_q "select now()")
# The share goes away first: three small fixtures scan in a few milliseconds,
# so a scan started before the drop finishes before the rule is in place. The
# folder still reads online here, so the scan reaches the dead share.
drop_nfs
check "a scan starts" start_scan
note "scan request answered $(api_status): $(head -c 300 "$TMP_ROOT/body" 2>/dev/null)"
sleep 2
note "latest scan after the drop: $(latest_scan_status)"
heartbeat_age() { psql_q "select coalesce(min(extract(epoch from now() - seen_at))::int, 9999) from worker_heartbeats where info -> 'queues' ? 'scan.root'"; }
fresh=1
for _ in 1 2 3; do
  sleep 35
  age=$(heartbeat_age)
  note "worker-files heartbeat age: ${age} s"
  [ "$age" -lt 65 ] || fresh=0
done
check "the worker-files heartbeat stays fresh through the outage (under 65 s, every 35 s for 105 s)" test "$fresh" = "1"
scan_parked() {
  [ "$(psql_q "select count(*) from scans where scan_root_id = '$ROOT_ID' and started_at >= '$t_scan' and status = 'aborted' and stats ->> 'offline' = 'true'")" -gt 0 ] ||
    [ "$(psql_q "select count(*) from parked_jobs where scan_root_id = '$ROOT_ID' and queue in ('scan.root', 'scan.dir')")" -gt 0 ]
}
if wait_until 120 scan_parked; then
  ok "the scan parks (aborted as offline, or parked)"
else
  fail "the scan parks (aborted as offline, or parked)"
  note "scans since the drop:"
  psql_q "select started_at, status, stats from scans where scan_root_id = '$ROOT_ID' and started_at >= '$t_scan' order by started_at" | sed 's/^/       /'
  note "parked jobs:"
  psql_q "select queue, reason, parked_at from parked_jobs" | sed 's/^/       /'
  note "worker-files log since the drop (scan, park, offline):"
  compose logs --no-color --since "$t_scan" worker-files 2>&1 | grep -E 'scan|park|offline|gate' | tail -n 40 | sed 's/^/       /'
fi
check "the API says offline" wait_until 120 folder_is offline
check "no file is marked missing" test "$(not_present_files)" = "0"
check "every fixture is still present" test "$(present_files)" = "$TRACKS"

APPLY=$(api POST "/libraries/$LIB_ID/tag-plans/$PLAN_ID/apply" '{}')
check "the Tag Plan apply is queued during the outage ($(api_status))" test "$(api_status)" = "202"
check "the API says the apply waits for the folder" test "$(echo "$APPLY" | jget waiting)" = "true"
check "the Tag Plan goes to waiting" wait_until 120 plan_is waiting
check "its items stay pending" test "$(psql_q "select count(*) from tag_plan_items where tag_plan_id = '$PLAN_ID' and status <> 'pending'")" = "0"
check "the audio files are unchanged during the outage" test "$(audio_md5s)" = "$MD5_BEFORE"

restore_nfs
check "the Tag Plan applies once the rule is removed" wait_until 180 plan_is applied
check "every item is applied" test "$(psql_q "select count(*) from tag_plan_items where tag_plan_id = '$PLAN_ID' and status = 'applied'")" = "$TRACKS"
check "every item's audio hash matches (before = after, recorded)" test "$(psql_q "select count(*) from tag_plan_items where tag_plan_id = '$PLAN_ID' and audio_hash_before is not null and audio_hash_before = audio_hash_after")" = "$TRACKS"
check "the FLAC audio MD5s are unchanged after the write" test "$(audio_md5s)" = "$MD5_BEFORE"
check "the genre is written to every fixture" genres_written
check "no file is marked missing after the outage" test "$(not_present_files)" = "0"
check "the folder is online again" wait_until 240 folder_is none

# ================================================================ 4. mounted later
step "4. mounted later"

timeout 120 "${COMPOSE[@]}" down --timeout 20
umount "$MUSIC"
MADE_MOUNT=0
check "the share is unmounted" test "$(mountpoint -q "$MUSIC" && echo yes || echo no)" = "no"
timeout 180 "${COMPOSE[@]}" up -d
check "worker-files and player run with the share unmounted" wait_until 120 both_running
worker_before=$(container_of worker-files)
started_before=$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$worker_before")
player_before=$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$(container_of player)")
lists_fixtures() { [ "$(compose exec -T worker-files ls "/mnt/music/$ALBUM_DIR" 2>/dev/null | grep -c '\.flac$')" = "$TRACKS" ]; }
player_lists() { [ "$(compose exec -T player ls "/host/music/$ALBUM_DIR" 2>/dev/null | grep -c '\.flac$')" = "$TRACKS" ]; }
check "worker-files sees no fixture before the mount" test "$(lists_fixtures && echo yes || echo no)" = "no"
mount_share
check "the share is mounted again on the host" mountpoint -q "$MUSIC"
check "worker-files lists the fixtures at /mnt/music through propagation" wait_until 30 lists_fixtures
check "the player lists them at /host/music" wait_until 30 player_lists
check "worker-files was not restarted" test "$(container_of worker-files)" = "$worker_before" -a "$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$worker_before")" = "$started_before"
check "the player was not restarted" test "$(docker inspect -f '{{.State.StartedAt}} {{.RestartCount}}' "$(container_of player)")" = "$player_before"
wait_until 60 app_healthy || true
login >/dev/null 2>&1 || true
check "the folder reads online" wait_until 240 folder_is none
t_later=$(psql_q "select now()")
scan_after_mount() {
  [ "$(psql_q "select count(*) from scans where scan_root_id = '$ROOT_ID' and started_at >= '$t_later' and status = 'completed'")" -gt 0 ]
}
start_scan || true
check "a scan after the mount completes" wait_until 180 scan_after_mount
check "the scan finds every fixture" test "$(present_files)" = "$TRACKS"
check "no file is marked missing" test "$(not_present_files)" = "0"

# ================================================================ 5. direct layout
step "5. direct layout regression"

# config_bind ENV_FILE SERVICE TARGET SOURCE PROPAGATION READ_ONLY
config_bind() {
  local json
  json=$(docker compose --project-directory "$OLD" -f "$INSTALL/compose.yml" --env-file "$1" -p "$PROJECT-old" config --format json) || return 1
  python3 -c '
import json, sys
cfg = json.loads(sys.stdin.read())
service, target, source, propagation, read_only = sys.argv[1:6]
for v in cfg["services"][service].get("volumes", []):
    if v.get("target") == target:
        got = (v.get("type"), v.get("source"), (v.get("bind") or {}).get("propagation"), str(bool(v.get("read_only"))).lower())
        want = ("bind", source, propagation, read_only)
        if got == want:
            sys.exit(0)
        print("     got %r, want %r" % (got, want))
        sys.exit(1)
print("     no volume on %s" % target)
sys.exit(1)
' "$2" "$3" "$4" "$5" "$6" <<<"$json"
}
cat >"$OLD/ro.env" <<EOF
COMPOSE_PROFILES=app,files,player
TAGAVE_VERSION=0.37.0
APP_SECRET=offlinetest
POSTGRES_PASSWORD=offlinetest
MUSIC_DIR='/srv/media/music'
TAGAVE_MUSIC_MODE=ro
EOF
cat >"$OLD/rw.env" <<EOF
COMPOSE_PROFILES=app,files,player
TAGAVE_VERSION=0.37.0
APP_SECRET=offlinetest
POSTGRES_PASSWORD=offlinetest
MUSIC_DIR='/srv/media/music'
TAGAVE_MUSIC_MODE=rw
EOF
check "an old read-only .env: worker-files binds MUSIC_DIR on /mnt/music, ro, rprivate" config_bind "$OLD/ro.env" worker-files /mnt/music /srv/media/music rprivate true
check "an old read-only .env: the player binds MUSIC_DIR on /music, ro, rprivate" config_bind "$OLD/ro.env" player /music /srv/media/music rprivate true
check "an old writable .env: worker-files binds MUSIC_DIR on /mnt/music, rw, rprivate" config_bind "$OLD/rw.env" worker-files /mnt/music /srv/media/music rprivate false
check "this run's parent .env: worker-files binds the parent on /mnt/.host, rw, rslave" config_bind "$INSTALL/.env" worker-files /mnt/.host "$MNT" rslave false
check "this run's parent .env: the player binds the parent on /host, ro, rslave" config_bind "$INSTALL/.env" player /host "$MNT" rslave true

exit 0

#!/usr/bin/env bash
# Runs install-tagave.sh --yes --no-start for each role against the deploy/
# files in this checkout, and checks what it writes: compose accepts the
# configuration, the secrets files are private, a split install's two halves
# agree, and the published database listens where it was told to.
#
# The optional updater and player profiles are checked the same way.
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
# The music bind check's own folder (offlinetest-<random>), removed with $work.
layout="$(mktemp -d "${TMPDIR:-/tmp}/offlinetest-XXXXXX")"
trap '[ "${TAGAVE_TEST_KEEP:-0}" = 1 ] && echo "kept $work $layout" || rm -rf "$work" "$layout"' EXIT

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

# --- the music bind from .env --------------------------------------------------
# compose.yml's music binds of worker-files and player, every part from .env:
# an old .env renders exactly today's bind, an old rw .env (only
# TAGAVE_MUSIC_MODE=rw) keeps a writable worker bind, and the parent layout
# keys move it to the folder above the share.
cp "$repo/deploy/compose.yml" "$layout/compose.yml"
# music_binds: the music bind of worker-files and of player, and their music settings, in one line each.
music_binds() {
  (cd "$layout" && docker compose config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
for name, env in (("worker-files", ["TAGAVE_MUSIC_NAME"]), ("player", ["ND_MUSICFOLDER", "ND_SCANNER_PURGEMISSING"])):
    s = c["services"][name]
    v = [v for v in s["volumes"] if v["type"] == "bind"][0]
    b = v.get("bind", {})
    print(name, "source:", v["source"], "target:", v["target"], "read_only:", str(v.get("read_only", False)).lower(),
          "propagation:", b.get("propagation"), *("%s=%s" % (k, s["environment"].get(k)) for k in env))'
}
layout_env() {
  printf 'TAGAVE_VERSION=0.38.0\nAPP_SECRET=offlinetest-not-a-secret\nPOSTGRES_PASSWORD=offlinetest-not-a-password\nCOMPOSE_PROFILES=files,player\nMUSIC_DIR=/mnt/music\n%s' "$1" >"$layout/.env"
}
layout_env ''
got="$(music_binds)"
[ "$got" = "worker-files source: /mnt/music target: /mnt/music read_only: true propagation: rprivate TAGAVE_MUSIC_NAME=
player source: /mnt/music target: /music read_only: true propagation: rprivate ND_MUSICFOLDER=/music ND_SCANNER_PURGEMISSING=never" ] \
  || fail "music bind: an old .env does not render today's bind: $got"
layout_env 'TAGAVE_MUSIC_MODE=rw
'
got="$(music_binds)"
[ "$got" = "worker-files source: /mnt/music target: /mnt/music read_only: false propagation: rprivate TAGAVE_MUSIC_NAME=
player source: /mnt/music target: /music read_only: true propagation: rprivate ND_MUSICFOLDER=/music ND_SCANNER_PURGEMISSING=never" ] \
  || fail "music bind: an old rw .env does not keep a writable worker bind and a read-only player: $got"
layout_env 'TAGAVE_MUSIC_BIND_SOURCE=/mnt
TAGAVE_MUSIC_BIND_TARGET=/mnt/.host
TAGAVE_PLAYER_BIND_TARGET=/host
TAGAVE_MUSIC_PROPAGATION=rslave
TAGAVE_MUSIC_NAME=music
TAGAVE_PLAYER_MUSIC_FOLDER=/host/music
'
got="$(music_binds)"
[ "$got" = "worker-files source: /mnt target: /mnt/.host read_only: true propagation: rslave TAGAVE_MUSIC_NAME=music
player source: /mnt target: /host read_only: true propagation: rslave ND_MUSICFOLDER=/host/music ND_SCANNER_PURGEMISSING=never" ] \
  || fail "music bind: the parent layout keys do not render the parent bind: $got"
rm "$layout/compose.yml" "$layout/.env"
pass "music bind: an old .env renders today's bind, an old rw .env a writable worker bind, the parent keys the parent bind"

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
public_url="$(env_value PUBLIC_URL "$work/all/.env")"
case "$public_url" in http://*:3100) ;; *) fail "role all: PUBLIC_URL should default to this computer's address, got '$public_url'" ;; esac
printf '%s' "$config" | grep -q "\"PUBLIC_URL\": \"$public_url\"" || fail "role all: app does not get PUBLIC_URL"
printf '%s' "$config" | grep -q '"published": "5432"' && fail "role all: postgres must not be published"
pass "role all"

# Re-running keeps the secrets.
run --role all --dir "$work/all" --music "$work/music" >"$work/all2.log" 2>&1 \
  || { cat "$work/all2.log" >&2; fail "role all, second run"; }
[ "$(env_value APP_SECRET "$work/all/.env")" = "$secret" ] || fail "role all: re-run replaced APP_SECRET"
run --role all --dir "$work/all" --music "$work/music" --public-url https://music.example.com >"$work/all3.log" 2>&1 \
  || { cat "$work/all3.log" >&2; fail "role all, --public-url"; }
run --role all --dir "$work/all" --music "$work/music" >"$work/all4.log" 2>&1 \
  || { cat "$work/all4.log" >&2; fail "role all, run after --public-url"; }
[ "$(env_value PUBLIC_URL "$work/all/.env")" = "https://music.example.com" ] || fail "role all: re-run replaced PUBLIC_URL"
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

# --- writable music -----------------------------------------------------------
[ "$(env_value TAGAVE_MUSIC_MODE "$work/all/.env")" = "ro" ] || fail "default music mode is not ro"
render "$work/all" | grep -q '"read_only": true' || fail "a read-only install does not mount the music read-only"
run --role all --music-writable --dir "$work/rw" --music "$work/music" >"$work/rw.log" 2>&1 \
  || { cat "$work/rw.log" >&2; fail "--music-writable"; }
[ "$(env_value TAGAVE_MUSIC_MODE "$work/rw/.env")" = "rw" ] || fail "--music-writable: TAGAVE_MUSIC_MODE"
render "$work/rw" | grep -q '"read_only": true' && fail "--music-writable: the music mount is still read-only"
run --role all --dir "$work/rw" --music "$work/music" >"$work/rw2.log" 2>&1 \
  || { cat "$work/rw2.log" >&2; fail "--music-writable, re-run"; }
[ "$(env_value TAGAVE_MUSIC_MODE "$work/rw/.env")" = "rw" ] || fail "--music-writable: a re-run lost rw"
render "$work/rw" | grep -q '"read_only": true' && fail "--music-writable: a re-run mounts the music read-only"
pass "--music-writable mounts the music read-write and keeps it on a re-run"

# --- the music check on a share that does not answer -------------------------
# TAGAVE_TEST_MOUNTINFO stands in for /proc/self/mountinfo. The music folder
# sits under an nfs4 mount whose path has a space (\040 in mountinfo); nothing
# listens at 192.0.2.10 (TEST-NET-1). The folder itself does not exist, so the
# install only passes when the folder tests are skipped.
esc_work="$(printf '%s' "$work" | sed 's/ /\\040/g')"
printf '%s\n' \
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw' \
  "40 22 0:50 / $esc_work/nas\\040share rw,relatime shared:9 - nfs4 192.0.2.10:/export/music rw,vers=4.2,hard,addr=192.0.2.10" \
  >"$work/mountinfo-silent"
# This case waits the installer's full 5 s for the share, so it runs in the
# background while the cases after it run; the checks at the end read it.
(
  started=$SECONDS
  status=0
  TAGAVE_TEST_MOUNTINFO="$work/mountinfo-silent" run --role all --dir "$work/silent" --music "$work/nas share/music" \
    >"$work/silent.log" 2>&1 || status=$?
  printf '%s %s\n' "$status" "$((SECONDS - started))" >"$work/silent.result"
) &
silent_share_job=$!
check_silent_share() {
  local status took
  wait "$silent_share_job" || true
  read -r status took <"$work/silent.result" || fail "music check: the silent share case left no result"
  [ "$status" = 0 ] || { cat "$work/silent.log" >&2; fail "music check: a silent share failed the install"; }
  grep -qF "Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable." "$work/silent.log" \
    || { cat "$work/silent.log" >&2; fail "music check: a silent share is not explained"; }
  [ "$took" -lt 15 ] || fail "music check: waited ${took}s on a silent share"
  grep -q 'vers=4.2' "$work/silent.log" && fail "music check: printed the mount's options"
  pass "music check with a silent share (after ${took}s)"
}

# A local mount, and an nfs4 mount on a longer name that is not a parent
# folder ($work/mus is not over $work/music): the check runs as today.
printf '%s\n' \
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw' \
  "41 22 8:2 / $esc_work/music rw,relatime shared:10 - ext4 /dev/sdb1 rw" \
  "42 22 0:51 / $esc_work/mus rw,relatime shared:11 - nfs4 192.0.2.10:/export/music rw" \
  >"$work/mountinfo-local"
TAGAVE_TEST_MOUNTINFO="$work/mountinfo-local" run --role all --dir "$work/local-mnt" --music "$work/music" \
  >"$work/local-mnt.log" 2>&1 || { cat "$work/local-mnt.log" >&2; fail "music check: a local mount failed the install"; }
grep -q "Music folder $work/music" "$work/local-mnt.log" || fail "music check: a local mount skipped the folder check"
grep -q "doesn't answer" "$work/local-mnt.log" && fail "music check: probed a share for a local folder"
if TAGAVE_TEST_MOUNTINFO="$work/mountinfo-local" run --role all --dir "$work/local-mnt2" --music "$work/music-gone" \
  >"$work/local-mnt2.log" 2>&1; then fail "music check: a missing local folder was accepted"; fi
grep -q 'does not exist' "$work/local-mnt2.log" || { cat "$work/local-mnt2.log" >&2; fail "music check: a missing local folder is not explained"; }
pass "music check on a local mount runs as before"

# --repair with --no-start: the check is skipped, and the installer says so.
run --role all --dir "$work/all" --music "$work/music" --repair >"$work/all-repair.log" 2>&1 \
  || { cat "$work/all-repair.log" >&2; fail "--repair --no-start"; }
grep -q -- '--repair does nothing with --no-start or --dry-run.' "$work/all-repair.log" || fail "--repair --no-start: no word that it does nothing"
pass "--repair with --no-start says it does nothing"

# traced ARGS...: the installer under bash -x (the trace in $work/trace.log),
# to see which folder tests ran.
traced() {
  TAGAVE_SKIP_IMAGE_CHECK=1 bash -x "$installer" --yes --no-start --version edge --timezone UTC "$@" </dev/null 2>"$work/trace.log"
}
# The default /mnt/music is looked at only when its mount is local or answers.
# The silent share above waits the installer's full 5 s; the cases after it
# wait 1 s (TAGAVE_TEST_SHARE_WAIT), the same check with a shorter limit.
printf '%s\n' \
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw' \
  '43 22 0:52 / /mnt/music rw,relatime shared:12 - nfs4 192.0.2.10:/export/music rw' \
  >"$work/mountinfo-default"
# --music-direct: this case is about the default folder, and on Linux the real
# /mnt would otherwise decide the layout.
TAGAVE_TEST_SHARE_WAIT=1 TAGAVE_TEST_MOUNTINFO="$work/mountinfo-default" traced --role all --dir "$work/defmusic" --music-direct >"$work/defmusic.log" \
  || { cat "$work/defmusic.log" "$work/trace.log" >&2; fail "music default: a silent /mnt/music failed the install"; }
grep -q -- '-d /mnt/music' "$work/trace.log" && fail "music default: looked at /mnt/music on a share that does not answer"
[ "$(env_value MUSIC_DIR "$work/defmusic/.env")" = "/mnt/music" ] \
  || { cat "$work/defmusic.log" >&2; fail "music default: a silent /mnt/music was dropped for $(env_value MUSIC_DIR "$work/defmusic/.env")"; }
grep -qF "Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable." "$work/trace.log" \
  || fail "music default: a silent /mnt/music is not explained"
grep -q 'No music folder given' "$work/trace.log" && fail "music default: a silent /mnt/music was called no music folder"
TAGAVE_TEST_MOUNTINFO="$work/mountinfo-local" traced --role all --dir "$work/defmusic2" >"$work/defmusic2.log" \
  || { cat "$work/defmusic2.log" >&2; fail "music default: a local /mnt/music failed the install"; }
grep -q -- '-d /mnt/music' "$work/trace.log" || fail "music default: did not look at /mnt/music on a local mount"
# A relative --music is made absolute without entering the folder.
mkdir -p "$work/music-rel"
(cd "$work" && traced --role all --dir "$work/rel" --music music-rel >"$work/rel.log") \
  || { cat "$work/rel.log" >&2; fail "music: a relative --music failed the install"; }
grep -q 'cd music-rel' "$work/trace.log" && fail "music: a relative --music was entered with cd"
[ "$(env_value MUSIC_DIR "$work/rel/.env")" = "$(cd "$work" && pwd)/music-rel" ] || fail "music: a relative --music became $(env_value MUSIC_DIR "$work/rel/.env")"
# A share whose server name tagave cannot check: the folder tests still run, bounded.
printf '%s\n' \
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw' \
  "44 22 0:53 / $esc_work/music rw,relatime shared:13 - nfs4 bad_host!:/export/music rw" \
  >"$work/mountinfo-odd"
TAGAVE_TEST_MOUNTINFO="$work/mountinfo-odd" run --role all --dir "$work/odd" --music "$work/music" >"$work/odd.log" 2>&1 \
  || { cat "$work/odd.log" >&2; fail "music check: a share with an odd server name failed the install"; }
grep -q "Music folder $work/music" "$work/odd.log" || fail "music check: a share with an odd server name skipped the folder check"
pass "the music default and a relative --music touch no folder before the share answers"

# --- the opt-in updater --------------------------------------------------------
run --role all --with-updater --dir "$work/updater" --music "$work/music" >"$work/updater.log" 2>&1 \
  || { cat "$work/updater.log" >&2; fail "--with-updater"; }
[ "$(env_value COMPOSE_PROFILES "$work/updater/.env")" = "app,files,updater" ] || fail "--with-updater: profiles"
[ "$(env_value TAGAVE_INSTALL_DIR "$work/updater/.env")" = "$work/updater" ] || fail "--with-updater: TAGAVE_INSTALL_DIR"
[ "$(env_value TAGAVE_UPDATER_URL "$work/updater/.env")" = "http://updater:8080" ] || fail "--with-updater: TAGAVE_UPDATER_URL"
[ "$(services "$work/updater")" = "app postgres updater worker-files worker-identify " ] || fail "--with-updater: services are $(services "$work/updater")"
config="$(render "$work/updater")"
printf '%s' "$config" | grep -q '"TAGAVE_UPDATER_URL": "http://updater:8080"' || fail "--with-updater: the app does not get TAGAVE_UPDATER_URL"
printf '%s' "$config" | grep -q '"source": "/var/run/docker.sock"' || fail "--with-updater: the updater has no Docker socket"
updater_json="$(cd "$work/updater" && docker compose config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); u=c["services"]["updater"]; print(json.dumps(u.get("ports")), sorted(u["networks"]), sorted(v["source"] for v in u["volumes"]), c["networks"]["updater"].get("internal"))')"
[ "$updater_json" = "null ['updater'] ['$work/updater', '/var/run/docker.sock'] True" ] \
  || fail "--with-updater: the updater must publish no port, sit only on the internal network and mount only the socket and the install folder (got: $updater_json)"
# Without the profile the same compose file has no updater, and the app no URL.
[ "$(services "$work/all")" = "app postgres worker-files worker-identify " ] || fail "updater: present without the profile"
render "$work/all" | grep -q '"TAGAVE_UPDATER_URL": ""' || fail "updater: the app has an updater URL without the profile"
pass "--with-updater adds the updater: socket and install folder only, internal network, no port"

run --role all --dir "$work/updater" --music "$work/music" >"$work/updater2.log" 2>&1 \
  || { cat "$work/updater2.log" >&2; fail "--with-updater, re-run"; }
[ "$(env_value COMPOSE_PROFILES "$work/updater/.env")" = "app,files,updater" ] || fail "updater: a re-run without the flag dropped it"
pass "re-running the installer keeps the updater"

if run --role files --with-updater --dir "$work/files-upd" --from "$work/app/files-worker.env" --music "$work/music" >"$work/files-upd.log" 2>&1; then
  fail "updater: accepted --with-updater for --role files"
fi
grep -q 'runs next to the app' "$work/files-upd.log" || fail "updater: --role files refusal does not say why"
pass "the file worker computer refuses the updater"

# enable-updater and disable-updater on an existing install (nothing started).
cp -R "$work/all" "$work/enable"
if "$installer" enable-updater --dir "$work/enable" --no-start </dev/null >"$work/enable-noyes.log" 2>&1; then
  fail "enable-updater: went ahead without --yes and without a terminal"
fi
[ "$(env_value COMPOSE_PROFILES "$work/enable/.env")" = "app,files" ] || fail "enable-updater: changed .env without confirmation"
TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" enable-updater --dir "$work/enable" --yes --no-start </dev/null >"$work/enable.log" 2>&1 \
  || { cat "$work/enable.log" >&2; fail "enable-updater"; }
grep -q 'root on this computer' "$work/enable.log" || fail "enable-updater: does not say what the socket gives"
[ "$(env_value COMPOSE_PROFILES "$work/enable/.env")" = "app,files,updater" ] || fail "enable-updater: profiles"
[ "$(env_value TAGAVE_INSTALL_DIR "$work/enable/.env")" = "$work/enable" ] || fail "enable-updater: TAGAVE_INSTALL_DIR"
[ "$(env_value TAGAVE_UPDATER_URL "$work/enable/.env")" = "http://updater:8080" ] || fail "enable-updater: TAGAVE_UPDATER_URL"
[ "$(mode_of "$work/enable/.env")" = "600" ] || fail "enable-updater: .env is no longer mode 600"
[ "$(services "$work/enable")" = "app postgres updater worker-files worker-identify " ] || fail "enable-updater: services are $(services "$work/enable")"
TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" enable-updater --dir "$work/enable" --yes --no-start </dev/null >"$work/enable2.log" 2>&1 \
  || { cat "$work/enable2.log" >&2; fail "enable-updater, again"; }
[ "$(env_value COMPOSE_PROFILES "$work/enable/.env")" = "app,files,updater" ] || fail "enable-updater: a second run doubled the profile"
"$installer" disable-updater --dir "$work/enable" --yes --no-start </dev/null >"$work/disable.log" 2>&1 \
  || { cat "$work/disable.log" >&2; fail "disable-updater"; }
[ "$(env_value COMPOSE_PROFILES "$work/enable/.env")" = "app,files" ] || fail "disable-updater: profiles"
[ -z "$(env_value TAGAVE_UPDATER_URL "$work/enable/.env")" ] || fail "disable-updater: TAGAVE_UPDATER_URL still set"
[ "$(services "$work/enable")" = "app postgres worker-files worker-identify " ] || fail "disable-updater: services are $(services "$work/enable")"
if TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" enable-updater --dir "$work/files" --yes --no-start </dev/null >"$work/enable-files.log" 2>&1; then
  fail "enable-updater: accepted the file worker computer"
fi
pass "enable-updater asks first, writes the settings once; disable-updater removes them"

# --- the opt-in player ----------------------------------------------------------
is_hex64() { printf '%s' "$1" | grep -Eqx '[0-9a-f]{64}'; }
# player_json DIR: the player service as compose renders it, in a few words,
# and the services whose environment holds the player password.
player_json() {
  (cd "$1" && docker compose config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
p = c["services"]["player"]
music = [v for v in p["volumes"] if v["target"] == "/music"][0]
data = [v for v in p["volumes"] if v["target"] == "/data"][0]
print(p["image"], [x["published"] for x in p["ports"]], music.get("read_only", False), data["type"], data["source"],
      p["environment"]["ND_ENABLESHARING"], p["environment"]["ND_ENABLEINSIGHTSCOLLECTOR"], p["environment"]["ND_JELLYFIN_ENABLED"],
      p["environment"]["ND_DEEZER_ENABLED"], p["environment"]["ND_LASTFM_ENABLED"], p["environment"]["ND_LISTENBRAINZ_ENABLED"],
      sorted(n for n, s in c["services"].items() if sys.argv[1] and sys.argv[1] in (s.get("environment") or {}).values()))' \
    "$(env_value TAGAVE_PLAYER_PASSWORD "$1/.env")"
}
run --role all --with-player --dir "$work/player" --music "$work/music" >"$work/player.log" 2>&1 \
  || { cat "$work/player.log" >&2; fail "--with-player"; }
[ "$(mode_of "$work/player/.env")" = "600" ] || fail "--with-player: .env is not mode 600"
[ "$(env_value COMPOSE_PROFILES "$work/player/.env")" = "app,files,player" ] || fail "--with-player: profiles"
[ "$(env_value TAGAVE_PLAYER_URL "$work/player/.env")" = "http://player:4533" ] || fail "--with-player: TAGAVE_PLAYER_URL"
[ "$(env_value TAGAVE_PLAYER_USER "$work/player/.env")" = "admin" ] || fail "--with-player: TAGAVE_PLAYER_USER"
[ "$(env_value TAGAVE_PLAYER_PORT "$work/player/.env")" = "4533" ] || fail "--with-player: TAGAVE_PLAYER_PORT"
player_pw="$(env_value TAGAVE_PLAYER_PASSWORD "$work/player/.env")"
player_key="$(env_value TAGAVE_PLAYER_ENCRYPTION_KEY "$work/player/.env")"
is_hex64 "$player_pw" || fail "--with-player: TAGAVE_PLAYER_PASSWORD is not 64 hex characters"
is_hex64 "$player_key" || fail "--with-player: TAGAVE_PLAYER_ENCRYPTION_KEY is not 64 hex characters"
[ "$player_pw" != "$player_key" ] || fail "--with-player: the password and the key are the same"
grep -qF "$player_pw" "$work/player.log" && fail "--with-player: the installer printed the player password"
[ "$(services "$work/player")" = "app player postgres worker-files worker-identify " ] || fail "--with-player: services are $(services "$work/player")"
config="$(render "$work/player")"
printf '%s' "$config" | grep -q '"TAGAVE_PLAYER_URL": "http://player:4533"' || fail "--with-player: the app does not get TAGAVE_PLAYER_URL"
got="$(player_json "$work/player")"
[ "$got" = "deluan/navidrome:0.64.0 ['4533'] True volume player-data false false false false false false ['app', 'player']" ] \
  || fail "--with-player: the player must run the pinned image on port 4533, read the music read-only, keep its data in the player-data volume, with sharing, insights, Jellyfin, Deezer, Last.fm and ListenBrainz off (tagave scrobbles), and only the app and the player may get the password (got: $got)"
# Without the profile the same compose file is valid, has no player, and the app no URL.
[ "$(services "$work/all")" = "app postgres worker-files worker-identify " ] || fail "player: present without the profile"
render "$work/all" | grep -q '"TAGAVE_PLAYER_URL": ""' || fail "player: the app has a player URL without the profile"
grep -q '^TAGAVE_PLAYER_PASSWORD=' "$work/all/.env" && fail "player: an install without the player got a player password"
pass "--with-player adds the player: pinned image, music read-only, own volume, secrets only in .env"

run --role all --dir "$work/player" --music "$work/music" >"$work/player2.log" 2>&1 \
  || { cat "$work/player2.log" >&2; fail "--with-player, re-run"; }
[ "$(env_value COMPOSE_PROFILES "$work/player/.env")" = "app,files,player" ] || fail "player: a re-run without the flag dropped it"
[ "$(env_value TAGAVE_PLAYER_PASSWORD "$work/player/.env")" = "$player_pw" ] || fail "player: a re-run replaced the password"
[ "$(env_value TAGAVE_PLAYER_ENCRYPTION_KEY "$work/player/.env")" = "$player_key" ] || fail "player: a re-run replaced the encryption key"
pass "re-running the installer keeps the player and its secrets"

run --role all --with-player --music-writable --dir "$work/player-rw" --music "$work/music" >"$work/player-rw.log" 2>&1 \
  || { cat "$work/player-rw.log" >&2; fail "--with-player --music-writable"; }
case "$(player_json "$work/player-rw")" in *" True volume "*) ;; *) fail "player: --music-writable made the player's music writable" ;; esac
render "$work/player-rw" | python3 -c 'import json,sys; c=json.load(sys.stdin); v=[v for v in c["services"]["worker-files"]["volumes"] if v["target"]=="/mnt/music"][0]; sys.exit(1 if v.get("read_only") else 0)' \
  || fail "player: --music-writable no longer makes the file worker's music writable"
pass "the player reads the music read-only even with --music-writable"

run --role all --with-player --player-port 14533 --dir "$work/player-port" --music "$work/music" >"$work/player-port.log" 2>&1 \
  || { cat "$work/player-port.log" >&2; fail "--player-port"; }
[ "$(player_json "$work/player-port" | cut -d' ' -f2)" = "['14533']" ] || fail "--player-port: not published on 14533"
for bad in abc 70000 3100; do
  if run --role all --with-player --player-port "$bad" --dir "$work/player-bad" --music "$work/music" >"$work/player-bad.log" 2>&1; then
    fail "--player-port: accepted '$bad'"
  fi
  grep -qE 'player port must be a number|cannot share port' "$work/player-bad.log" || fail "--player-port $bad: refused without saying why"
done
pass "--player-port publishes the port it is given and refuses bad ones"

if run --role files --with-player --dir "$work/files-pl" --from "$work/app/files-worker.env" --music "$work/music" >"$work/files-pl.log" 2>&1; then
  fail "player: accepted --with-player for --role files"
fi
grep -q 'everything runs on one computer' "$work/files-pl.log" || fail "player: --role files refusal does not say why"
if run --role app --with-player --dir "$work/app-pl" --advertise-address "$address" >"$work/app-pl.log" 2>&1; then
  fail "player: accepted --with-player for --role app"
fi
grep -q 'Settings > Playback' "$work/app-pl.log" || fail "player: --role app refusal does not point at bring your own"
pass "split installs refuse the bundled player and point at bring your own"

# enable-player and disable-player on an existing install (nothing started).
cp -R "$work/all" "$work/enable-pl"
if "$installer" enable-player --dir "$work/enable-pl" --no-start </dev/null >"$work/enable-pl-noyes.log" 2>&1; then
  fail "enable-player: went ahead without --yes and without a terminal"
fi
[ "$(env_value COMPOSE_PROFILES "$work/enable-pl/.env")" = "app,files" ] || fail "enable-player: changed .env without confirmation"
"$installer" enable-player --dir "$work/enable-pl" --yes --no-start </dev/null >"$work/enable-pl.log" 2>&1 \
  || { cat "$work/enable-pl.log" >&2; fail "enable-player"; }
grep -q 'read-only' "$work/enable-pl.log" || fail "enable-player: does not say the music is read-only"
grep -q 'publishes port 4533' "$work/enable-pl.log" || fail "enable-player: does not say which port it publishes"
[ "$(env_value COMPOSE_PROFILES "$work/enable-pl/.env")" = "app,files,player" ] || fail "enable-player: profiles"
[ "$(env_value TAGAVE_PLAYER_URL "$work/enable-pl/.env")" = "http://player:4533" ] || fail "enable-player: TAGAVE_PLAYER_URL"
[ "$(env_value TAGAVE_PLAYER_USER "$work/enable-pl/.env")" = "admin" ] || fail "enable-player: TAGAVE_PLAYER_USER"
[ "$(env_value TAGAVE_PLAYER_PORT "$work/enable-pl/.env")" = "4533" ] || fail "enable-player: TAGAVE_PLAYER_PORT"
en_pw="$(env_value TAGAVE_PLAYER_PASSWORD "$work/enable-pl/.env")"
en_key="$(env_value TAGAVE_PLAYER_ENCRYPTION_KEY "$work/enable-pl/.env")"
is_hex64 "$en_pw" || fail "enable-player: TAGAVE_PLAYER_PASSWORD is not 64 hex characters"
is_hex64 "$en_key" || fail "enable-player: TAGAVE_PLAYER_ENCRYPTION_KEY is not 64 hex characters"
grep -qF "$en_pw" "$work/enable-pl.log" && fail "enable-player: printed the player password"
[ "$(mode_of "$work/enable-pl/.env")" = "600" ] || fail "enable-player: .env is no longer mode 600"
[ "$(services "$work/enable-pl")" = "app player postgres worker-files worker-identify " ] || fail "enable-player: services are $(services "$work/enable-pl")"
"$installer" enable-player --dir "$work/enable-pl" --yes --no-start </dev/null >"$work/enable-pl2.log" 2>&1 \
  || { cat "$work/enable-pl2.log" >&2; fail "enable-player, again"; }
[ "$(env_value COMPOSE_PROFILES "$work/enable-pl/.env")" = "app,files,player" ] || fail "enable-player: a second run doubled the profile"
[ "$(env_value TAGAVE_PLAYER_PASSWORD "$work/enable-pl/.env")" = "$en_pw" ] || fail "enable-player: a second run replaced the password"
"$installer" disable-player --dir "$work/enable-pl" --yes --no-start </dev/null >"$work/disable-pl.log" 2>&1 \
  || { cat "$work/disable-pl.log" >&2; fail "disable-player"; }
[ "$(env_value COMPOSE_PROFILES "$work/enable-pl/.env")" = "app,files" ] || fail "disable-player: profiles"
[ -z "$(env_value TAGAVE_PLAYER_URL "$work/enable-pl/.env")" ] || fail "disable-player: TAGAVE_PLAYER_URL still set"
[ "$(env_value TAGAVE_PLAYER_PASSWORD "$work/enable-pl/.env")" = "$en_pw" ] || fail "disable-player: dropped the password"
[ "$(env_value TAGAVE_PLAYER_ENCRYPTION_KEY "$work/enable-pl/.env")" = "$en_key" ] || fail "disable-player: dropped the encryption key"
[ "$(services "$work/enable-pl")" = "app postgres worker-files worker-identify " ] || fail "disable-player: services are $(services "$work/enable-pl")"
# The installer re-run after disable-player keeps it off and keeps the secrets.
run --role all --dir "$work/enable-pl" --music "$work/music" >"$work/enable-pl-rerun.log" 2>&1 \
  || { cat "$work/enable-pl-rerun.log" >&2; fail "disable-player, installer re-run"; }
[ "$(env_value COMPOSE_PROFILES "$work/enable-pl/.env")" = "app,files" ] || fail "disable-player: an installer re-run turned the player back on"
[ "$(env_value TAGAVE_PLAYER_PASSWORD "$work/enable-pl/.env")" = "$en_pw" ] || fail "disable-player: an installer re-run dropped the password"
"$installer" enable-player --dir "$work/enable-pl" --yes --no-start </dev/null >"$work/enable-pl3.log" 2>&1 \
  || { cat "$work/enable-pl3.log" >&2; fail "enable-player after disable"; }
[ "$(env_value TAGAVE_PLAYER_PASSWORD "$work/enable-pl/.env")" = "$en_pw" ] || fail "enable-player after disable: new password (the old Navidrome data would not open)"
[ "$(env_value TAGAVE_PLAYER_ENCRYPTION_KEY "$work/enable-pl/.env")" = "$en_key" ] || fail "enable-player after disable: new encryption key"
"$installer" enable-player --dir "$work/enable-pl" --player-port 0 --yes --no-start </dev/null >"$work/enable-pl-port.log" 2>&1 \
  && fail "enable-player: accepted port 0"
for d in files app; do
  if "$installer" enable-player --dir "$work/$d" --yes --no-start </dev/null >"$work/enable-pl-$d.log" 2>&1; then
    fail "enable-player: accepted role $d"
  fi
  grep -q 'everything runs on one computer' "$work/enable-pl-$d.log" || fail "enable-player: role $d refused without saying why"
done
pass "enable-player asks first and keeps its secrets; disable-player keeps them and clears the URL"

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
# FAKE_DOCKER_SILENT=1: a Docker that does not answer. FAKE_UNHEALTHY=SERVICE:
# that service's container reads "exited". FAKE_REPAIR_EXIT: the exit code of
# the updater's "cli.js repair" one-off, FAKE_REPAIR_HEADLINE the last line it
# prints. FAKE_SERVICES_FAIL=1: "compose config --services" fails.
case "$1" in
  info) [ "${FAKE_DOCKER_SILENT:-0}" != 1 ] || sleep 30; exit 0 ;;
  version) [ "${FAKE_DOCKER_SILENT:-0}" != 1 ] || sleep 30; echo 27.0.0; exit 0 ;;
  run)
    case "$*" in *"cli.js repair"*) echo 'fake repair: started the file worker'; echo "${FAKE_REPAIR_HEADLINE:-Repaired. All 4 parts running.}"; exit "${FAKE_REPAIR_EXIT:-0}" ;; esac
    exit 0 ;;
  manifest) echo '{"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'; exit 0 ;;
  inspect)
    case "$*" in
      *Config.Env*)
        [ -z "${FAKE_PG_USER:-}" ] || printf 'POSTGRES_USER=%s\nPOSTGRES_DB=%s\n' "$FAKE_PG_USER" "$FAKE_PG_USER"
        [ "${FAKE_APP_DOWN:-0}" = "1" ] || printf 'NODE_ENV=production\n%s=%s\n' "${FAKE_VERSION_VAR:-TAGAVE_BUILD_VERSION}" "$(cat "$FAKE_STATE/version")" ;;
      *fakeid-down) echo exited ;;
      *) echo healthy ;;
    esac
    exit 0 ;;
  volume) exit 1 ;;
  # Local images: "repository tag id" lines in $FAKE_IMAGES; containers made
  # from the image refs in $FAKE_CONTAINERS. rm refuses -f and an image in use.
  image)
    case "$2" in
      ls) if [ -n "${FAKE_IMAGES:-}" ]; then cat "$FAKE_IMAGES" || exit 1; fi ;;
      inspect) echo 1073741824 ;;
      rm)
        case "$*" in *" -f"*|*--force*) echo "fake docker: image rm with -f" >&2; exit 1 ;; esac
        if [ -n "${FAKE_CONTAINERS:-}" ] && grep -qxF -- "$3" "$FAKE_CONTAINERS"; then
          echo "Error response from daemon: conflict: unable to remove repository reference \"$3\" (must force)" >&2; exit 1
        fi
        awk -v ref="$3" '$1 ":" $2 != ref' "$FAKE_IMAGES" >"$FAKE_IMAGES.new" && mv "$FAKE_IMAGES.new" "$FAKE_IMAGES" ;;
    esac
    exit 0 ;;
  ps)
    if [ -n "${FAKE_CONTAINERS:-}" ]; then
      case "$*" in *--format*) cat "$FAKE_CONTAINERS" ;; *) awk '{print "c" NR}' "$FAKE_CONTAINERS" ;; esac
    fi
    exit 0 ;;
  compose) shift ;;
  *) exit 0 ;;
esac
case "$1" in
  version) echo 2.29.0 ;;
  config)
    case "$*" in *--services*) [ "${FAKE_SERVICES_FAIL:-0}" != 1 ] || exit 1 ;; esac
    exec "$REAL_DOCKER" compose "$@" ;;
  ps)
    if [ "${2:-}" = "--format" ]; then printf 'SERVICE STATE STATUS\napp running Up\n'
    elif [ -n "${FAKE_UNHEALTHY:-}" ] && [ "${3:-}" = "$FAKE_UNHEALTHY" ]; then echo fakeid-down
    else echo fakeid; fi ;;
  logs) echo '{"msg":"worker ready"}' ;;
  run) case "$*" in *pre-update*) echo saved ;; esac ;;
  up)
    if [ "$*" != "up -d postgres" ] && [ "${FAKE_UP_KEEPS_OLD:-0}" != "1" ]; then
      grep '^TAGAVE_VERSION=' .env | cut -d= -f2 | tr -d '\n' >"$FAKE_STATE/version"
    fi ;;
  exec)
    case "$*" in
      *" app node "*) [ "${FAKE_APP_DOWN:-0}" = "1" ] || printf '%s ok ok ok pass\n' "$(cat "$FAKE_STATE/version")" ;;
      *psql*) cat >/dev/null; echo "${FAKE_FILE_WORKERS:-0}" ;;
      *pg_dump*) printf 'PGDMP fake dump' ;;
      *"pg_restore --list"*) cat >/dev/null; printf ';\n; Archive\n215; 1259 16385 TABLE public albums tagave\n' ;;
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
# Empty when nothing matches (grep's exit status would end the script under pipefail).
line_of() { { grep -nx -- "$1" "$work/docker.log" || true; } | head -n 1 | cut -d: -f1; }
# count TEXT FILE: how many lines of FILE hold TEXT.
count() { grep -cF -- "$1" "$2" || true; }

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

# Dumps from four earlier updates, plus files the pruning must leave alone.
mkdir -p "$work/upd/backups"
for old in 0.3.0-20260101-100000 0.3.1-20260201-100000 0.3.2-20260301-100000 0.3.3-20260401-100000; do
  mkdir -p "$work/upd/backups/pre-update-$old"
  printf 'PGDMP old' >"$work/upd/backups/pre-update-$old/database.pgdump"
  printf 'TAGAVE_VERSION=%s\n' "${old%%-*}" >"$work/upd/backups/pre-update-$old/.env"
  printf 'services: {}\n' >"$work/upd/backups/pre-update-$old/docker-compose.yml"
done
mkdir -p "$work/upd/backups/pre-update-by-hand"
printf 'PGDMP mine' >"$work/upd/backups/pre-update-by-hand/database.pgdump"
printf 'PGDMP mine' >"$work/upd/backups/my-own.pgdump"

# An rw install from before 0.38.0: TAGAVE_MUSIC_MODE=rw and nothing new.
sed 's/^TAGAVE_MUSIC_MODE=ro$/TAGAVE_MUSIC_MODE=rw/' "$work/upd/.env" >"$work/upd-rw.env"
cp "$work/upd-rw.env" "$work/upd/.env"

: >"$work/docker.log"
fake update --dir "$work/upd" --yes >"$work/update.log" 2>&1 || { cat "$work/update.log" >&2; fail "update"; }
[ "$(env_value TAGAVE_VERSION "$work/upd/.env")" = "0.5.0" ] || fail "update: .env not moved to 0.5.0"
[ "$(env_value TAGAVE_MUSIC_MODE "$work/upd/.env")" = "rw" ] || fail "update: an rw install lost TAGAVE_MUSIC_MODE=rw"
render "$work/upd" | grep -q '"read_only": true' && fail "update: an rw install from before 0.38.0 mounts the music read-only with the new compose.yml"
backup="$(find "$work/upd/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-0.4.1-*' | head -n 1)"
[ -n "$backup" ] || fail "update: no pre-update-0.4.1 backup folder"
[ -s "$backup/database.pgdump" ] || fail "update: no database dump in $backup"
[ "$(env_value TAGAVE_VERSION "$backup/.env")" = "0.4.1" ] || fail "update: the saved .env is not the 0.4.1 one"
[ "$(mode_of "$backup")" = "700" ] || fail "update: the backup folder is not private"
dump_at="$(grep -n 'pg_dump' "$work/docker.log" | head -n 1 | cut -d: -f1)"
if ! grep -q -- 'pg_dump.*--exclude-table-data=public.cover_thumbs' "$work/docker.log"; then
  cat "$work/docker.log" >&2; fail "update: the pre-update dump does not leave out the cover thumbnails"
fi
# a roll back point: the provider cache stays in
if grep -q -- '--exclude-table-data=public.provider_cache' "$work/docker.log"; then
  cat "$work/docker.log" >&2; fail "update: the pre-update dump leaves out the provider cache"
fi
stop_at="$(line_of 'compose stop worker-files worker-identify')"
[ -n "$stop_at" ] || stop_at="$(line_of 'compose stop worker-identify worker-files')"
app_at="$(line_of 'compose up -d app')"
rest_at="$(line_of 'compose up -d')"
if [ -z "$dump_at" ] || [ -z "$stop_at" ] || [ -z "$app_at" ] || [ -z "$rest_at" ]; then
  cat "$work/docker.log" >&2; fail "update: missing backup, stop or start calls"
fi
if ! { [ "$dump_at" -lt "$stop_at" ] && [ "$stop_at" -lt "$app_at" ] && [ "$app_at" -lt "$rest_at" ]; }; then
  cat "$work/docker.log" >&2; fail "update: expected backup, stop workers, start app, then the rest"
fi
grep -q 'How to roll back to 0.4.1' "$work/update.log" || fail "update: no roll back instructions"
grep -q 'pg_restore' "$work/update.log" || fail "update: roll back does not restore the database"
pass "update backs up (without thumbnails, with the provider cache), pins 0.5.0, restarts the app before the workers, prints the roll back"

# D6: the newest 3 pre-update dumps stay (this update's and the two before it);
# older dumps go, but every folder keeps its .env and compose copy.
for old in 0.3.2-20260301-100000 0.3.3-20260401-100000; do
  [ -s "$work/upd/backups/pre-update-$old/database.pgdump" ] || fail "update: removed the dump of pre-update-$old, one of the newest 3"
done
for old in 0.3.0-20260101-100000 0.3.1-20260201-100000; do
  [ ! -e "$work/upd/backups/pre-update-$old/database.pgdump" ] || fail "update: kept the dump of pre-update-$old, older than the newest 3"
  [ -f "$work/upd/backups/pre-update-$old/.env" ] || fail "update: removed the saved .env of pre-update-$old"
  [ -f "$work/upd/backups/pre-update-$old/docker-compose.yml" ] || fail "update: removed the saved compose file of pre-update-$old"
done
[ -s "$work/upd/backups/pre-update-by-hand/database.pgdump" ] || fail "update: removed a dump in a folder it did not name"
[ -s "$work/upd/backups/my-own.pgdump" ] || fail "update: removed a file it did not write"
grep -q 'Removed 2 older pre-update database backup' "$work/update.log" || fail "update: does not say it removed 2 older dumps"
pass "update keeps the newest 3 pre-update dumps and every saved .env and compose file"

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

# Old images: after the update only 0.5.0 and 0.4.1 stay of tagave's own; an
# image a stopped container uses, other repositories and non-release tags stay.
at_version 0.4.1 --role all --dir "$work/upd-img" --music "$work/music" >"$work/upd-img-install.log" 2>&1 \
  || { cat "$work/upd-img-install.log" >&2; fail "old images: install 0.4.1"; }
printf '0.4.1' >"$work/state/version"
reg=ghcr.io/xooxoxxo
{
  for v in 0.3.0 0.4.0 0.4.1 0.5.0; do
    for n in app worker updater; do printf '%s/tagave-%s %s sha256:%s%s\n' "$reg" "$n" "$v" "$n" "$v"; done
  done
  printf '%s/tagave-app edge sha256:edge\n' "$reg"
  printf '%s/tagave-app 0.4.0-rc.10 sha256:rc10\n' "$reg"
  printf 'postgres 16 sha256:pg\n'
  printf '%s/tagave-app-fork 0.1.0 sha256:fork\n' "$reg"
  printf 'ghcr.io/someone/tagave-app 0.1.0 sha256:someone\n'
  printf 'deluan/navidrome 0.50.0 sha256:nd\n'
} >"$work/images"
printf '%s/tagave-worker:0.4.0\n' "$reg" >"$work/containers"
: >"$work/docker.log"
FAKE_IMAGES="$work/images" FAKE_CONTAINERS="$work/containers" fake update --dir "$work/upd-img" --yes >"$work/upd-img.log" 2>&1 \
  || { cat "$work/upd-img.log" >&2; fail "old images: update"; }
expected="$(cat <<EXPECTED
deluan/navidrome 0.50.0
ghcr.io/someone/tagave-app 0.1.0
postgres 16
$reg/tagave-app 0.4.0-rc.10
$reg/tagave-app 0.4.1
$reg/tagave-app 0.5.0
$reg/tagave-app edge
$reg/tagave-app-fork 0.1.0
$reg/tagave-updater 0.4.1
$reg/tagave-updater 0.5.0
$reg/tagave-worker 0.4.0
$reg/tagave-worker 0.4.1
$reg/tagave-worker 0.5.0
EXPECTED
)"
got="$(awk '{print $1, $2}' "$work/images" | LC_ALL=C sort)"
if [ "$got" != "$(printf '%s\n' "$expected" | LC_ALL=C sort)" ]; then
  printf 'left:\n%s\n' "$got" >&2; cat "$work/upd-img.log" >&2; fail "old images: wrong images left"
fi
grep -q 'Removed 5 old image(s), 5.0 GB' "$work/upd-img.log" || { cat "$work/upd-img.log" >&2; fail "old images: no summary of what was removed"; }
grep -q "Kept $reg/tagave-worker:0.4.0: a container uses it" "$work/upd-img.log" || fail "old images: does not say why it kept an image in use"
if grep -E -q 'prune|image rm (-f|--force)' "$work/docker.log"; then fail "old images: pruned or forced a removal"; fi
pass "update removes the tagave images older than the version it came from, and nothing else"

# A Docker that cannot list images: a warning, and the update still succeeds.
printf '0.4.1' >"$work/state/version"
sed -i.orig 's/^TAGAVE_VERSION=.*/TAGAVE_VERSION=0.4.1/' "$work/upd-img/.env"
FAKE_IMAGES="$work/no-such-file" fake update --dir "$work/upd-img" --version 0.5.0 --yes >"$work/upd-img2.log" 2>&1 \
  || { cat "$work/upd-img2.log" >&2; fail "old images: a failing image list failed the update"; }
grep -q 'tagave now runs 0.5.0' "$work/upd-img2.log" || fail "old images: update did not finish"
grep -q 'Could not list the images' "$work/upd-img2.log" || fail "old images: no warning when the images cannot be listed"
pass "a failure to remove old images does not fail the update"

# The player: a release that pins another Navidrome copies its data first.
at_version 0.4.1 --role all --with-player --dir "$work/upd-pl" --music "$work/music" >"$work/upd-pl-install.log" 2>&1 \
  || { cat "$work/upd-pl-install.log" >&2; fail "update player: install 0.4.1"; }
sed 's|deluan/navidrome:0\.64\.0|deluan/navidrome:0.63.0|' "$work/upd-pl/compose.yml" >"$work/upd-pl/compose.yml.new" \
  && mv "$work/upd-pl/compose.yml.new" "$work/upd-pl/compose.yml"
printf '0.4.1' >"$work/state/version"
fake status --dir "$work/upd-pl" >"$work/upd-pl-status.log" 2>&1 || { cat "$work/upd-pl-status.log" >&2; fail "status with the player"; }
grep -q 'Player: *healthy (port 4533)' "$work/upd-pl-status.log" || fail "status: does not show the player"
: >"$work/docker.log"
printf 'deluan/navidrome 0.62.0 a\ndeluan/navidrome 0.63.0 b\ndeluan/navidrome 0.64.0 c\ndeluan/navidrome latest d\n' >"$work/pl-images"
FAKE_IMAGES="$work/pl-images" fake update --dir "$work/upd-pl" --yes >"$work/upd-pl.log" 2>&1 || { cat "$work/upd-pl.log" >&2; fail "update with a new player image"; }
# Only the exact image the player ran before goes; 0.62.0 may not be tagave's.
[ "$(awk '{print $2}' "$work/pl-images" | tr '\n' ' ')" = "0.62.0 0.64.0 latest " ] || fail "update: expected only the player's previous 0.63.0 image removed, left $(tr '\n' ' ' <"$work/pl-images")"
stop_pl="$(line_of 'compose stop player')"
snap_pl="$({ grep -n 'entrypoint sh player' "$work/docker.log" || true; } | head -n 1 | cut -d: -f1)"
app_at="$(line_of 'compose up -d app')"
if [ -z "$stop_pl" ] || [ -z "$snap_pl" ] || [ -z "$app_at" ] || ! { [ "$stop_pl" -lt "$snap_pl" ] && [ "$snap_pl" -lt "$app_at" ]; }; then
  cat "$work/docker.log" >&2; fail "update: expected stop player, copy its data, then start the new app"
fi
grep -q 'navidrome:0.63.0 to deluan/navidrome:0.64.0' "$work/upd-pl.log" || fail "update: does not say the player image changes"
grep -q 'stop app .* player' "$work/upd-pl.log" || fail "update: roll back does not stop the player"
grep -q 'cp -a /data/snapshots/pre-update /data/navidrome' "$work/upd-pl.log" || fail "update: roll back does not restore the player's data"
grep -qF "$(env_value TAGAVE_PLAYER_PASSWORD "$work/upd-pl/.env")" "$work/upd-pl.log" && fail "update: printed the player password"
pass "update copies the player's data before a new Navidrome starts, and the roll back restores it"

# The same Navidrome on both sides: nothing to copy.
at_version 0.4.1 --role all --with-player --dir "$work/upd-pl2" --music "$work/music" >"$work/upd-pl2-install.log" 2>&1 \
  || { cat "$work/upd-pl2-install.log" >&2; fail "update player: second install"; }
printf '0.4.1' >"$work/state/version"
: >"$work/docker.log"
fake update --dir "$work/upd-pl2" --yes >"$work/upd-pl2.log" 2>&1 || { cat "$work/upd-pl2.log" >&2; fail "update with the same player image"; }
grep -q 'entrypoint sh player' "$work/docker.log" && fail "update: copied the player's data although its image did not change"
grep -q "needs nothing restored" "$work/upd-pl2.log" || fail "update: roll back does not say the player needs nothing"
grep -q 'The player is up' "$work/upd-pl2.log" || fail "update: did not check the player after the update"
pass "update leaves the player's data alone when its image stays the same"

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

# --- repair: a re-run that finds parts down, and the repair command ----------
# 0.34.0 is FIRST_REPAIR_RELEASE, the first whose updater image has cli.js repair.
at_version 0.34.0 --role all --dir "$work/rep" --music "$work/music" >"$work/rep-install.log" 2>&1 \
  || { cat "$work/rep-install.log" >&2; fail "repair: install 0.34.0"; }
printf '0.34.0' >"$work/state/version"
rep_project="$(env_value COMPOSE_PROJECT_NAME "$work/rep/.env")"
rep_project="${rep_project:-tagave}"
# rep ARGS...: the installer on $work/rep against the stand-in docker; the app
# answers its health check from $work/appsrv.
rep() { TAGAVE_SKIP_IMAGE_CHECK=1 fake "$@" --dir "$work/rep" --app-url "file://$work/appsrv"; }

: >"$work/docker.log"
rep --yes >"$work/rep-healthy.log" 2>&1 || { cat "$work/rep-healthy.log" >&2; fail "repair: healthy re-run"; }
[ -n "$(line_of 'version')" ] || { cat "$work/docker.log" >&2; fail "repair: a re-run did not check whether Docker answers"; }
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: a healthy re-run ran a repair"
grep -q "aren't running" "$work/rep-healthy.log" && fail "repair: a healthy re-run reported parts down"
[ -n "$(line_of 'compose up -d')" ] || fail "repair: a healthy re-run no longer starts tagave"
pass "healthy re-run is unchanged"

# --repair on a healthy install: nothing to repair, the re-run carries on.
: >"$work/docker.log"
rep --yes --repair >"$work/rep-healthy2.log" 2>&1 || { cat "$work/rep-healthy2.log" >&2; fail "repair: healthy re-run with --repair"; }
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: --repair on a healthy install ran a repair"
[ -n "$(line_of 'compose up -d')" ] || fail "repair: --repair on a healthy install did not carry on"
pass "--repair on a healthy install carries on as a re-run"

# An install whose updater image has no cli.js repair (before 0.34.0): a
# re-run with a part down starts the parts as before, never exit 3.
at_version 0.4.1 --role all --dir "$work/rep-old" --music "$work/music" >"$work/rep-old-install.log" 2>&1 \
  || { cat "$work/rep-old-install.log" >&2; fail "repair: install 0.4.1"; }
: >"$work/docker.log"
status=0
FAKE_UNHEALTHY=worker-files TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --dir "$work/rep-old" --app-url "file://$work/appsrv" \
  >"$work/rep-old.log" 2>&1 || status=$?
[ "$status" = 0 ] || { cat "$work/rep-old.log" >&2; fail "repair: a re-run of 0.4.1 with a part down exited $status"; }
grep -qF "This tagave version can't repair itself yet, so the installer starts the parts as usual." "$work/rep-old.log" \
  || { cat "$work/rep-old.log" >&2; fail "repair: a re-run of 0.4.1 does not say why it does not repair"; }
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: a re-run of 0.4.1 ran cli.js repair, which its updater image lacks"
[ -n "$(line_of 'compose up -d')" ] || { cat "$work/docker.log" >&2; fail "repair: a re-run of 0.4.1 with a part down did not start the parts"; }
status=0
: >"$work/docker.log"
fake repair --dir "$work/rep-old" --yes >"$work/rep-old2.log" 2>&1 || status=$?
[ "$status" = 1 ] || { cat "$work/rep-old2.log" >&2; fail "repair command on 0.4.1 exited $status, not 1"; }
grep -qF 'Repair needs tagave 0.34.0 or newer. Update first, or run the installer again to start the parts.' "$work/rep-old2.log" \
  || { cat "$work/rep-old2.log" >&2; fail "repair command on 0.4.1: no plain reason"; }
grep -q '^run ' "$work/docker.log" && fail "repair command on 0.4.1 ran a container"
pass "an install before 0.34.0 re-runs as before, and its repair command says what it needs"

# An install folder whose name has a space: the repair cannot run from it, and says so.
cp -R "$work/rep" "$work/rep space"
sed "s#^TAGAVE_INSTALL_DIR=.*#TAGAVE_INSTALL_DIR=$work/rep space#" "$work/rep/.env" >"$work/rep space/.env"
: >"$work/docker.log"
status=0
FAKE_UNHEALTHY=worker-files TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --dir "$work/rep space" --app-url "file://$work/appsrv" \
  >"$work/rep-space.log" 2>&1 || status=$?
[ "$status" = 0 ] || { cat "$work/rep-space.log" >&2; fail "repair: a re-run in a folder with a space exited $status"; }
grep -qF "The repair can't run from a folder whose name has a space, so the installer starts the parts as usual." "$work/rep-space.log" \
  || { cat "$work/rep-space.log" >&2; fail "repair: a re-run in a folder with a space does not say why it does not repair"; }
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: ran cli.js repair from a folder with a space"
status=0
: >"$work/docker.log"
fake repair --dir "$work/rep space" --yes >"$work/rep-space2.log" 2>&1 || status=$?
[ "$status" = 1 ] || { cat "$work/rep-space2.log" >&2; fail "repair command in a folder with a space exited $status, not 1"; }
grep -qF "The repair can't run from a folder whose name has a space. Run the installer again to start the parts." "$work/rep-space2.log" \
  || { cat "$work/rep-space2.log" >&2; fail "repair command in a folder with a space: no plain reason"; }
grep -q 'needs tagave' "$work/rep-space2.log" && fail "repair command in a folder with a space blames the version"
grep -q '^run ' "$work/docker.log" && fail "repair command in a folder with a space ran a container"
pass "an install folder with a space re-runs as before, and its repair command says why it cannot repair"

cp "$work/rep/.env" "$work/rep-env.before"
: >"$work/docker.log"
status=0
FAKE_UNHEALTHY=worker-files rep --yes >"$work/rep-yes.log" 2>&1 || status=$?
[ "$status" = 3 ] || { cat "$work/rep-yes.log" >&2; fail "repair: unhealthy plus --yes exited $status, not 3"; }
grep -q "tagave is installed here, but 1 of 4 parts aren't running." "$work/rep-yes.log" || { cat "$work/rep-yes.log" >&2; fail "repair: --yes does not say what is down"; }
grep -q 'Run again with --repair' "$work/rep-yes.log" || fail "repair: --yes does not say how to repair"
cmp -s "$work/rep/.env" "$work/rep-env.before" || fail "repair: --yes changed .env although it stopped"
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: --yes without --repair ran a repair"
grep -Eq '^compose (up|pull)' "$work/docker.log" && fail "repair: --yes without --repair started something"
pass "unhealthy plus --yes exits 3 and prints \"Run again with --repair\""

# on_terminal INPUT LOG CMD...: runs CMD on a new pseudo-terminal that is its
# controlling terminal, so the installer's /dev/tty is that terminal. INPUT
# is typed ahead, one line per question asked, then a dozen Enters, so a
# question nobody expected takes its default instead of waiting. What the
# terminal shows lands in LOG. Returns CMD's exit status, or 124 when it is
# still running after 60 s (it is killed).
on_terminal() {
  python3 - "$@" <<'PY'
import os, pty, select, signal, sys, time
typed, log, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
os.write(fd, (typed + '\n' * 12).encode())
shown = b''
deadline = time.monotonic() + 60
code = None
while code is None:
    left = deadline - time.monotonic()
    if left <= 0:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        code = 124
        break
    ready, _, _ = select.select([fd], [], [], min(left, 1))
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        chunk = b''
    if not chunk:
        code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    shown += chunk
with open(log, 'wb') as f:
    f.write(shown)
sys.exit(code)
PY
}
# rep_tty INPUT LOG: rep without --yes, on a terminal, with the file worker down.
rep_tty() {
  on_terminal "$1" "$2" env PATH="$work/bin:$PATH" REAL_DOCKER="$real_docker" FAKE_LOG="$work/docker.log" FAKE_STATE="$work/state" \
    TAGAVE_RELEASES_API="$releases" TAGAVE_SKIP_IMAGE_CHECK=1 FAKE_UNHEALTHY=worker-files \
    "$installer" --dir "$work/rep" --app-url "file://$work/appsrv"
}
prompt="tagave is installed here, but 1 of 4 parts aren't running. Repair it now? (Y/n)"
# A yes, and Enter alone (Y is the default), repair and stop there.
for typed in 'y' ''; do
  : >"$work/docker.log"
  status=0
  rep_tty "$typed"$'\n' "$work/rep-tty.log" || status=$?
  [ "$status" = 0 ] || { cat "$work/rep-tty.log" >&2; fail "repair: the terminal answer '${typed:-Enter}' exited $status"; }
  [ "$(count "$prompt" "$work/rep-tty.log")" = 1 ] || { cat "$work/rep-tty.log" >&2; fail "repair: the terminal was not asked once: $prompt"; }
  grep -q 'cli.js repair' "$work/docker.log" || { cat "$work/docker.log" >&2; fail "repair: the terminal answer '${typed:-Enter}' did not repair"; }
  grep -q 'Repaired. All 4 parts running.' "$work/rep-tty.log" || fail "repair: the terminal answer '${typed:-Enter}' printed no headline"
  grep -Eq '^compose (up|pull)' "$work/docker.log" && fail "repair: the terminal answer '${typed:-Enter}' also reinstalled"
  cmp -s "$work/rep/.env" "$work/rep-env.before" || fail "repair: the terminal answer '${typed:-Enter}' changed .env"
done
# A no: no repair, the re-run carries on as before and starts the parts (the
# Enters after the n take every later question's default).
: >"$work/docker.log"
status=0
rep_tty $'n\n' "$work/rep-tty.log" || status=$?
[ "$status" = 0 ] || { cat "$work/rep-tty.log" >&2; fail "repair: the terminal answer n exited $status"; }
[ "$(count "$prompt" "$work/rep-tty.log")" = 1 ] || { cat "$work/rep-tty.log" >&2; fail "repair: the terminal was not asked once before a no"; }
grep -q 'cli.js repair' "$work/docker.log" && fail "repair: the terminal answer n ran a repair"
grep -q 'Repairing tagave' "$work/rep-tty.log" && fail "repair: the terminal answer n started repairing"
[ -n "$(line_of 'compose up -d')" ] || { cat "$work/rep-tty.log" >&2; fail "repair: the terminal answer n did not carry on and start tagave"; }
cp "$work/rep/.env" "$work/rep-env.before"
pass "on a terminal, a re-run asks \"Repair it now? (Y/n)\": y and Enter repair, n carries on"

: >"$work/docker.log"
FAKE_UNHEALTHY=worker-files rep --yes --repair >"$work/rep-repair.log" 2>&1 || { cat "$work/rep-repair.log" >&2; fail "repair: unhealthy plus --repair"; }
run_line="$(grep 'cli.js repair' "$work/docker.log" || true)"
case "$run_line" in
  "run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $work/rep:$work/rep -w $work/rep -e TAGAVE_INSTALL_DIR=$work/rep --network ${rep_project}_default --entrypoint node "*"/opt/tagave/updater/dist/cli.js repair") ;;
  *) cat "$work/docker.log" >&2; fail "repair: --repair did not run cli.js repair in a one-off container with the socket and the install folder (got: $run_line)" ;;
esac
grep -q 'Repaired. All 4 parts running.' "$work/rep-repair.log" || fail "repair: --repair does not print the headline"
grep -Eq '^compose (up|pull)' "$work/docker.log" && fail "repair: --repair also reinstalled"
cmp -s "$work/rep/.env" "$work/rep-env.before" || fail "repair: --repair changed .env"
pass "unhealthy plus --repair runs cli.js repair in a one-off container with the socket and the install dir mounted"

# A re-run on a silent Docker waits the installer's full 10 s, so it runs in
# the background, on its own copy of the install and its own docker log, while
# the cases after it run; the checks at the end read it.
cp -R "$work/rep" "$work/rep-dsilent"
cp "$work/rep-dsilent/.env" "$work/rep-dsilent.env.before"
(
  started=$SECONDS
  status=0
  PATH="$work/bin:$PATH" REAL_DOCKER="$real_docker" FAKE_LOG="$work/docker-dsilent.log" FAKE_STATE="$work/state" \
    FAKE_DOCKER_SILENT=1 TAGAVE_RELEASES_API="$releases" TAGAVE_SKIP_IMAGE_CHECK=1 \
    "$installer" --yes --dir "$work/rep-dsilent" --app-url "file://$work/appsrv" </dev/null >"$work/rep-silent.log" 2>&1 || status=$?
  printf '%s %s\n' "$status" "$((SECONDS - started))" >"$work/rep-silent.result"
) &
silent_docker_job=$!
check_silent_docker() {
  local status took
  wait "$silent_docker_job" || true
  read -r status took <"$work/rep-silent.result" || fail "repair: the silent Docker case left no result"
  [ "$status" = 6 ] || { cat "$work/rep-silent.log" >&2; fail "repair: a silent Docker exited $status, not 6"; }
  grep -q "Docker isn't answering. Restart Docker or the computer, then run the installer again." "$work/rep-silent.log" || fail "repair: a silent Docker is not explained"
  [ "$took" -lt 20 ] || fail "repair: waited ${took}s on a silent Docker"
  cmp -s "$work/rep-dsilent/.env" "$work/rep-dsilent.env.before" || fail "repair: a silent Docker run changed .env"
  pass "Docker not answering exits 6 (after ${took}s)"
}

# The case above waits the installer's full 10 s for Docker; this one waits
# 1 s (TAGAVE_TEST_DOCKER_WAIT), the same check with a shorter limit.
started=$SECONDS
status=0
: >"$work/docker.log"
FAKE_DOCKER_SILENT=1 TAGAVE_TEST_DOCKER_WAIT=1 fake repair --dir "$work/rep" --yes >"$work/rep-silent2.log" 2>&1 || status=$?
took=$((SECONDS - started))
[ "$status" = 6 ] || { cat "$work/rep-silent2.log" >&2; fail "repair command: a silent Docker exited $status, not 6"; }
grep -q "Docker isn't answering. Restart Docker or the computer, then run the installer again." "$work/rep-silent2.log" \
  || fail "repair command: a silent Docker is not explained"
grep -q 'cli.js repair' "$work/docker.log" && fail "repair command: ran the repair on a silent Docker"
[ "$took" -lt 8 ] || fail "repair command: waited ${took}s on a silent Docker with a 1 s limit"
pass "the repair command on a silent Docker exits 6 (after ${took}s)"

# compose cannot list the parts: say so, never call it healthy silently.
: >"$work/docker.log"
FAKE_SERVICES_FAIL=1 FAKE_UNHEALTHY=worker-files rep --yes >"$work/rep-nolist.log" 2>&1 \
  || { cat "$work/rep-nolist.log" >&2; fail "repair: a re-run stopped when compose could not list the parts"; }
grep -q 'tagave could not check its parts here.' "$work/rep-nolist.log" || { cat "$work/rep-nolist.log" >&2; fail "repair: no word that the parts could not be checked"; }
[ -n "$(line_of 'compose up -d')" ] || fail "repair: a re-run that could not check the parts did not carry on"
pass "a re-run that cannot list the parts says so and carries on"

# Values from .env reach the one-off docker run only when they are valid.
cp -R "$work/rep" "$work/rep-badenv"
for bad in 'COMPOSE_PROJECT_NAME=Bad Name' 'TAGAVE_REGISTRY=-evil' 'TAGAVE_DIGEST_UPDATER=sha256:abc'; do
  { grep -v "^${bad%%=*}=" "$work/rep/.env"; printf '%s\n' "$bad"; } >"$work/rep-badenv/.env"
  : >"$work/docker.log"
  if fake repair --dir "$work/rep-badenv" --yes >"$work/rep-badenv.log" 2>&1; then fail "repair: accepted $bad"; fi
  grep -q "${bad%%=*}" "$work/rep-badenv.log" || { cat "$work/rep-badenv.log" >&2; fail "repair: refused $bad without naming the key"; }
  grep -q '^run ' "$work/docker.log" && fail "repair: ran a container with $bad"
done
pass "repair refuses a bad registry, digest or project name from .env before docker run"

# A silent share: the configuration is written, nothing is started.
: >"$work/docker.log"
TAGAVE_TEST_SHARE_WAIT=1 TAGAVE_TEST_MOUNTINFO="$work/mountinfo-silent" TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --version 0.4.1 --timezone UTC \
  --role all --dir "$work/silent-start" --music "$work/nas share/music" >"$work/silent-start.log" 2>&1 \
  || { cat "$work/silent-start.log" >&2; fail "music check: a silent share without --no-start failed"; }
grep -q 'tagave starts once the share answers: run the installer again then.' "$work/silent-start.log" \
  || { cat "$work/silent-start.log" >&2; fail "music check: a silent share does not say when tagave starts"; }
[ -f "$work/silent-start/.env" ] || fail "music check: a silent share wrote no configuration"
grep -Eq '^compose (up|pull)' "$work/docker.log" && fail "music check: started tagave on a silent share"
pass "a silent share writes the configuration and starts nothing"

: >"$work/docker.log"
status=0
FAKE_REPAIR_EXIT=4 FAKE_REPAIR_HEADLINE="Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable. Run the installer again once it's back." \
  fake repair --dir "$work/rep" --wait 30 --yes >"$work/rep-wait.log" 2>&1 || status=$?
[ "$status" = 4 ] || { cat "$work/rep-wait.log" >&2; fail "repair: exit 4 became $status"; }
grep -q 'cli.js repair --wait 30$' "$work/docker.log" || { cat "$work/docker.log" >&2; fail "repair: --wait 30 was not passed on"; }
[ "$(count "Run the installer again once it's back." "$work/rep-wait.log")" = 1 ] \
  || { cat "$work/rep-wait.log" >&2; fail "repair: waiting on music without the updater does not say once to run the installer again"; }
[ "$(count 'finishes on its own' "$work/rep-wait.log")" = 0 ] \
  || { cat "$work/rep-wait.log" >&2; fail "repair: waiting on music without the updater promises it finishes on its own"; }
cp -R "$work/rep" "$work/rep-upd"
sed 's/^COMPOSE_PROFILES=.*/&,updater/' "$work/rep/.env" >"$work/rep-upd/.env"
status=0
: >"$work/docker.log"
FAKE_REPAIR_EXIT=4 FAKE_REPAIR_HEADLINE="Your music share at 192.0.2.10 doesn't answer. Turn the NAS on or check its cable. tagave finishes on its own when it's back." \
  fake repair --dir "$work/rep-upd" --wait 30 --yes >"$work/rep-wait2.log" 2>&1 || status=$?
grep -q 'cli.js repair$' "$work/docker.log" || { cat "$work/docker.log" >&2; fail "repair: with the updater, --wait was passed on (its service watches the share)"; }
grep -q 'so --wait is not needed here' "$work/rep-wait2.log" || fail "repair: with the updater, --wait dropped without saying why"
[ "$status" = 4 ] || { cat "$work/rep-wait2.log" >&2; fail "repair with the updater: exit 4 became $status"; }
[ "$(count "tagave finishes on its own when it's back." "$work/rep-wait2.log")" = 1 ] \
  || { cat "$work/rep-wait2.log" >&2; fail "repair: waiting on music with the updater does not say once that it finishes on its own"; }
[ "$(count 'installer again' "$work/rep-wait2.log")" = 0 ] || fail "repair: with the updater, still says to run the installer again"
for code in 5:5 2:1 1:1; do
  status=0
  FAKE_REPAIR_EXIT="${code%:*}" fake repair --dir "$work/rep" --yes >"$work/rep-code.log" 2>&1 || status=$?
  [ "$status" = "${code#*:}" ] || { cat "$work/rep-code.log" >&2; fail "repair: exit ${code%:*} became $status, not ${code#*:}"; }
  if [ "${code%:*}" = 2 ]; then
    grep -qF 'Repair needs tagave 0.34.0 or newer. Update first, or run the installer again to start the parts.' "$work/rep-code.log" \
      || { cat "$work/rep-code.log" >&2; fail "repair: an updater without cli.js repair (exit 2) is not explained"; }
  fi
done
# repair on a healthy install runs the repair, which finds nothing to do.
: >"$work/docker.log"
FAKE_REPAIR_HEADLINE='All 4 parts running. Nothing to repair.' fake repair --dir "$work/rep" --yes >"$work/rep-none.log" 2>&1 \
  || { cat "$work/rep-none.log" >&2; fail "repair command on a healthy install"; }
grep -q 'All 4 parts running. Nothing to repair.' "$work/rep-none.log" || fail "repair command on a healthy install: no headline"
grep -Eq '^compose (up|pull)' "$work/docker.log" && fail "repair command on a healthy install reinstalled"
# The image check before the one-off is bounded (a silent Docker cannot hang it).
PATH="$work/bin:$PATH" REAL_DOCKER="$real_docker" FAKE_LOG="$work/docker.log" FAKE_STATE="$work/state" \
  bash -x "$installer" repair --dir "$work/rep" --yes </dev/null >/dev/null 2>"$work/trace.log" \
  || { cat "$work/trace.log" >&2; fail "repair command under trace"; }
grep -q 'run_limited 30 docker image inspect' "$work/trace.log" || fail "repair: docker image inspect runs without a limit"
for bad in 0 121 abc; do
  if fake repair --dir "$work/rep" --wait "$bad" --yes >"$work/rep-bad.log" 2>&1; then fail "repair: accepted --wait $bad"; fi
  grep -q 'minutes from 1 to 120' "$work/rep-bad.log" || { cat "$work/rep-bad.log" >&2; fail "repair: --wait $bad refused without saying why"; }
done
pass "repair passes --wait 30 through (not with the updater on) and maps the updater's exit codes"

# --- an install from before 0.9 (the project's old name, liner) -------------
# LINER_* settings in .env, database user and name "liner", an images that
# report their version as LINER_VERSION. The new compose files must work with
# that .env as it is (the in-app updater of 0.8 copies them without touching
# .env), and the installer renames the settings once its compose files read
# the new names, keeping values, a private backup and the database names.
at_version 0.4.1 --role all --dir "$work/legacy" --music "$work/music" >"$work/legacy-install.log" 2>&1 \
  || { cat "$work/legacy-install.log" >&2; fail "pre-0.9: install"; }
legacy_env="$work/legacy/.env"
sed -e 's/^POSTGRES_USER=.*/POSTGRES_USER=liner/' -e 's/^POSTGRES_DB=.*/POSTGRES_DB=liner/' "$legacy_env" >"$legacy_env.new"
printf 'LINER_LIBRARY_ID=lib-123\nLINER_PREMIGRATE_BACKUP_KEEP=7\nLINER_ALLOW_SCHEMA_SKEW=0\nTAGAVE_ALLOW_SCHEMA_SKEW=1\n' >>"$legacy_env.new"
mv "$legacy_env.new" "$legacy_env" && chmod 600 "$legacy_env"
pg_password="$(env_value POSTGRES_PASSWORD "$legacy_env")"
# the 0.8 compose.yml read LINER_LIBRARY_ID from .env
# shellcheck disable=SC2016 # compose variables, not shell ones
sed 's/TAGAVE_LIBRARY_ID: ${TAGAVE_LIBRARY_ID:-${LINER_LIBRARY_ID:-}}/LINER_LIBRARY_ID: ${LINER_LIBRARY_ID:-}/' \
  "$repo/deploy/compose.yml" >"$work/legacy/compose.yml"

# The new compose files with the old .env, unchanged.
mkdir -p "$work/legacy-new"
cp "$legacy_env" "$work/legacy-new/.env"
cp "$repo/deploy/compose.yml" "$repo/deploy/compose.db-published.yml" "$work/legacy-new/"
legacy_config="$(render "$work/legacy-new")"
printf '%s' "$legacy_config" | grep -q '"TAGAVE_LIBRARY_ID": "lib-123"' || fail "pre-0.9: new compose files lose LINER_LIBRARY_ID from an old .env"
printf '%s' "$legacy_config" | grep -q '"TAGAVE_ALLOW_SCHEMA_SKEW": "1"' || fail "pre-0.9: new compose files do not read TAGAVE_ALLOW_SCHEMA_SKEW"
printf '%s' "$legacy_config" | grep -qF "postgres://liner:$pg_password@postgres:5432/liner" || fail "pre-0.9: the app no longer reaches the liner database"
printf '%s' "$legacy_config" | grep -q '"POSTGRES_USER": "liner"' || fail "pre-0.9: postgres would be created with another user"
pass "the new compose files run an install from before 0.9 with its .env as it is"

# An older compose.yml in the folder: enable-updater leaves the old names alone.
TAGAVE_SKIP_IMAGE_CHECK=1 "$installer" enable-updater --dir "$work/legacy" --yes --no-start </dev/null >"$work/legacy-enable.log" 2>&1 \
  || { cat "$work/legacy-enable.log" >&2; fail "pre-0.9: enable-updater"; }
[ "$(env_value LINER_LIBRARY_ID "$legacy_env")" = "lib-123" ] || fail "pre-0.9: renamed settings an older compose.yml still reads"
"$installer" disable-updater --dir "$work/legacy" --yes --no-start </dev/null >"$work/legacy-disable.log" 2>&1 \
  || { cat "$work/legacy-disable.log" >&2; fail "pre-0.9: disable-updater"; }
pass "an older compose.yml keeps its LINER_* settings"

# update: new compose files, then .env renamed.
printf '0.4.1' >"$work/state/version"
: >"$work/docker.log"
FAKE_VERSION_VAR=LINER_VERSION fake update --dir "$work/legacy" --yes >"$work/legacy-update.log" 2>&1 \
  || { cat "$work/legacy-update.log" >&2; fail "pre-0.9: update"; }
[ "$(env_value TAGAVE_VERSION "$legacy_env")" = "0.5.0" ] || fail "pre-0.9: update did not move to 0.5.0"
grep -q '^LINER_' "$legacy_env" && fail "pre-0.9: LINER_* keys left in .env after the update"
[ "$(env_value TAGAVE_LIBRARY_ID "$legacy_env")" = "lib-123" ] || fail "pre-0.9: LINER_LIBRARY_ID not renamed with its value"
[ "$(env_value TAGAVE_PREMIGRATE_BACKUP_KEEP "$legacy_env")" = "7" ] || fail "pre-0.9: LINER_PREMIGRATE_BACKUP_KEEP not renamed"
[ "$(env_value TAGAVE_ALLOW_SCHEMA_SKEW "$legacy_env")" = "1" ] || fail "pre-0.9: the old name overrode a TAGAVE_* value already set"
[ "$(grep -c '^TAGAVE_ALLOW_SCHEMA_SKEW=' "$legacy_env")" = "1" ] || fail "pre-0.9: TAGAVE_ALLOW_SCHEMA_SKEW twice in .env"
if ! { [ "$(env_value POSTGRES_USER "$legacy_env")" = "liner" ] && [ "$(env_value POSTGRES_DB "$legacy_env")" = "liner" ]; }; then
  fail "pre-0.9: the update changed the database names"
fi
[ "$(env_value POSTGRES_PASSWORD "$legacy_env")" = "$pg_password" ] || fail "pre-0.9: the update changed the database password"
[ "$(mode_of "$legacy_env")" = "600" ] || fail "pre-0.9: .env is no longer mode 600"
# the update writes .env more than once; one of its backups has the old names
env_bak="$(find "$work/legacy" -maxdepth 1 -name '.env.bak.*' -newer "$work/legacy-disable.log" -exec grep -l '^LINER_LIBRARY_ID=lib-123' {} + | head -n 1)"
[ -n "$env_bak" ] || fail "pre-0.9: no backup of the .env with the old names"
[ "$(mode_of "$env_bak")" = "600" ] || fail "pre-0.9: the .env backup is not private"
backup="$(find "$work/legacy/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-0.4.1-*' | head -n 1)"
grep -q '^LINER_LIBRARY_ID=lib-123' "$backup/.env" || fail "pre-0.9: the roll back copy of .env lost the names the old version reads"
grep -q 'LINER_LIBRARY_ID->TAGAVE_LIBRARY_ID' "$work/legacy-update.log" || fail "pre-0.9: the update does not say what it renamed"
grep -qF "$pg_password" "$work/legacy-update.log" && fail "pre-0.9: the update printed the database password"
grep -qF "$(env_value APP_SECRET "$legacy_env")" "$work/legacy-update.log" && fail "pre-0.9: the update printed the app secret"
render "$work/legacy" | grep -qF "postgres://liner:$pg_password@postgres:5432/liner" || fail "pre-0.9: after the update the app does not reach the liner database"
render "$work/legacy" | grep -q '"TAGAVE_LIBRARY_ID": "lib-123"' || fail "pre-0.9: after the update the workers lost the library pin"
pass "update renames the pre-0.9 settings in .env, keeps values, the database names and a private backup"

# A re-run of the installer keeps the renamed settings and the database names.
TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --no-start --dir "$work/legacy" >"$work/legacy-rerun.log" 2>&1 \
  || { cat "$work/legacy-rerun.log" >&2; fail "pre-0.9: re-run"; }
[ "$(env_value TAGAVE_LIBRARY_ID "$legacy_env")" = "lib-123" ] || fail "pre-0.9: a re-run dropped TAGAVE_LIBRARY_ID"
[ "$(env_value POSTGRES_USER "$legacy_env")" = "liner" ] || fail "pre-0.9: a re-run changed POSTGRES_USER"
pass "re-running the installer keeps the renamed settings and the liner database"

# An .env that left the database names to the old compose defaults gets the
# names the database container was created with.
sed -e '/^POSTGRES_USER=/d' -e '/^POSTGRES_DB=/d' "$legacy_env" >"$legacy_env.new" && mv "$legacy_env.new" "$legacy_env" && chmod 600 "$legacy_env"
printf 'LINER_LIBRARY_ID=lib-456\n' >>"$legacy_env"
FAKE_PG_USER=liner TAGAVE_SKIP_IMAGE_CHECK=1 fake enable-updater --dir "$work/legacy" --yes --no-start >"$work/legacy-pin.log" 2>&1 \
  || { cat "$work/legacy-pin.log" >&2; fail "pre-0.9: enable-updater on an .env without database names"; }
if ! { [ "$(env_value POSTGRES_USER "$legacy_env")" = "liner" ] && [ "$(env_value POSTGRES_DB "$legacy_env")" = "liner" ]; }; then
  fail "pre-0.9: the database names the container was created with were not recorded"
fi
[ "$(env_value TAGAVE_LIBRARY_ID "$legacy_env")" = "lib-123" ] || fail "pre-0.9: an old LINER_* line overrode the TAGAVE_* value"
grep -q '^LINER_' "$legacy_env" && fail "pre-0.9: enable-updater left a LINER_* key"
pass "enable-updater records the database names and renames late LINER_* keys"

# A new install uses the new database names.
if ! { [ "$(env_value POSTGRES_USER "$work/all/.env")" = "tagave" ] && [ "$(env_value POSTGRES_DB "$work/all/.env")" = "tagave" ]; }; then
  fail "new install: database user and name should be tagave"
fi
grep -q '^LINER_' "$work/all/.env" && fail "new install: .env has LINER_* keys"
pass "a new install uses the tagave database names and no LINER_* settings"

# --- signed releases ------------------------------------------------------------
# The installer carries the release key; a key in deploy/release-keys must be
# the one embedded in install-tagave.sh too.
first_key="$(find "$repo/deploy/release-keys" -name '*.pem' 2>/dev/null | sort | head -n 1)"
if [ -n "$first_key" ]; then
  embedded="$(sed -n "/^RELEASE_PUBLIC_KEY='/,/'\$/p" "$installer" | sed "s/^RELEASE_PUBLIC_KEY='//; s/'\$//")"
  [ "$embedded" = "$(cat "$first_key")" ] || fail "RELEASE_PUBLIC_KEY in install-tagave.sh is not $first_key"
fi
pass "the installer's release key matches deploy/release-keys"

if openssl pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
  # A copy of the installer and deploy/ with a test key (never trusted anywhere else).
  signed_src="$work/signed-src"
  mkdir -p "$signed_src/deploy/release-keys" "$work/assets/v0.10.0" "$work/assets/v0.10.1"
  cp "$installer" "$signed_src/install-tagave.sh"
  cp "$repo/deploy/compose.yml" "$repo/deploy/compose.db-published.yml" "$signed_src/deploy/"
  openssl genpkey -algorithm ed25519 -out "$work/test-release.key" 2>/dev/null
  openssl pkey -in "$work/test-release.key" -pubout -out "$signed_src/deploy/release-keys/test.pem" 2>/dev/null
  openssl genpkey -algorithm ed25519 -out "$work/other.key" 2>/dev/null
  key_id() { openssl pkey -in "$1" -pubout -outform DER 2>/dev/null | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16; }
  d() { printf 'sha256:%s' "$(printf '%s' "$1" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"; }
  manifest() {
    cat <<JSON
{
  "schema": 1,
  "project": "tagave",
  "version": "$1",
  "publishedAt": "2026-10-16T00:00:00Z",
  "commit": "test",
  "images": {
    "app": {
      "ref": "ghcr.io/xooxoxxo/tagave-app:$1",
      "env": "TAGAVE_DIGEST_APP",
      "index": "$(d app-index)",
      "platforms": {
        "linux/amd64": "$(d app-amd64)",
        "linux/arm64": "$(d app-arm64)"
      },
      "services": [
        "app"
      ]
    },
    "dummy": {
      "ref": "example.test/dummy:1.0",
      "env": null,
      "index": null,
      "platforms": {
        "linux/amd64": "$(d dummy-amd64)",
        "linux/arm64": "$(d dummy-arm64)"
      },
      "services": []
    }
  },
  "modules": [],
  "files": {}
}
JSON
  }
  sign() { # sign MANIFEST KEY > SIG
    openssl pkeyutl -sign -inkey "$2" -rawin -in "$1" -out "$1.bin" 2>/dev/null
    printf 'tagave-release-signature v1\nkey %s\nsig %s\n' "$(key_id "$2")" "$(base64 <"$1.bin" | tr -d '\n')"
  }
  manifest 0.10.0 >"$work/assets/v0.10.0/release-manifest.json"
  sign "$work/assets/v0.10.0/release-manifest.json" "$work/test-release.key" >"$work/assets/v0.10.0/release-manifest.json.sig"
  signed_run() {
    TAGAVE_SKIP_IMAGE_CHECK=1 TAGAVE_RELEASE_ASSETS_URL="file://$work/assets" "$signed_src/install-tagave.sh" \
      --yes --no-start --timezone UTC --role all --music "$work/music" "$@" </dev/null
  }
  signed_run --dir "$work/signed" --version 0.10.0 >"$work/signed.log" 2>&1 || { cat "$work/signed.log" >&2; fail "signed: install"; }
  platform="$(DOCKER_DEFAULT_PLATFORM='' docker info --format '{{.Architecture}}' 2>/dev/null)"
  case "$platform" in x86_64|amd64) arch=amd64 ;; *) arch=arm64 ;; esac
  [ "$(env_value TAGAVE_DIGEST_APP "$work/signed/.env")" = "$(d "app-$arch")" ] || fail "signed: TAGAVE_DIGEST_APP is not the $arch digest"
  grep -q '^TAGAVE_DIGEST_DUMMY' "$work/signed/.env" && fail "signed: an image without an env key got a pin"
  cmp -s "$work/signed/release-manifest.json" "$work/assets/v0.10.0/release-manifest.json" || fail "signed: the manifest is not kept next to the install"
  render "$work/signed" | grep -q "\"image\": \"ghcr.io/xooxoxxo/tagave-app:0.10.0@$(d "app-$arch")\"" || fail "signed: compose does not run the pinned app image"
  grep -q 'signature checks out; 1 images pinned by digest' "$work/signed.log" || fail "signed: no word about the signature"
  pass "a signed release pins its images by digest and keeps the manifest"

  # Changed after signing, signed by another key, or for another version: refused, nothing written.
  manifest 0.10.0 | sed "s|$(d app-arm64)|$(d evil)|; s|$(d app-amd64)|$(d evil)|" >"$work/assets/v0.10.0/release-manifest.json.tampered"
  cp "$work/assets/v0.10.0/release-manifest.json" "$work/good.json"
  cp "$work/assets/v0.10.0/release-manifest.json.tampered" "$work/assets/v0.10.0/release-manifest.json"
  if signed_run --dir "$work/tampered" --version 0.10.0 >"$work/tampered.log" 2>&1; then fail "signed: a tampered manifest was accepted"; fi
  grep -q 'does not match its signature: it was changed after tagave signed it' "$work/tampered.log" || { cat "$work/tampered.log" >&2; fail "signed: the tampered refusal does not say why"; }
  [ -f "$work/tampered/.env" ] && fail "signed: a tampered manifest still wrote .env"
  cp "$work/good.json" "$work/assets/v0.10.0/release-manifest.json"
  sign "$work/assets/v0.10.0/release-manifest.json" "$work/other.key" >"$work/assets/v0.10.0/release-manifest.json.sig"
  if signed_run --dir "$work/forged" --version 0.10.0 >"$work/forged.log" 2>&1; then fail "signed: another key's signature was accepted"; fi
  grep -q "signed by key $(key_id "$work/other.key"), which is not the tagave release key" "$work/forged.log" || { cat "$work/forged.log" >&2; fail "signed: the wrong-signer refusal does not say why"; }
  manifest 0.10.0 >"$work/assets/v0.10.1/release-manifest.json"
  sign "$work/assets/v0.10.1/release-manifest.json" "$work/test-release.key" >"$work/assets/v0.10.1/release-manifest.json.sig"
  if signed_run --dir "$work/replayed" --version 0.10.1 >"$work/replayed.log" 2>&1; then fail "signed: the manifest of another version was accepted"; fi
  grep -q 'describes another release' "$work/replayed.log" || { cat "$work/replayed.log" >&2; fail "signed: the version refusal does not say why"; }
  sign "$work/assets/v0.10.0/release-manifest.json" "$work/test-release.key" >"$work/assets/v0.10.0/release-manifest.json.sig"
  pass "a tampered manifest, another signer and another version's manifest are refused before anything is written"

  # No manifest: tags, with a warning; TAGAVE_REQUIRE_SIGNATURE=1 refuses.
  signed_run --dir "$work/unsigned" --version 0.9.5 >"$work/unsigned.log" 2>&1 || { cat "$work/unsigned.log" >&2; fail "unsigned: install"; }
  grep -q 'is not checked against its signature (release 0.9.5 publishes no signed manifest)' "$work/unsigned.log" || fail "unsigned: no warning"
  grep -q '^TAGAVE_DIGEST_' "$work/unsigned/.env" && fail "unsigned: pins without a manifest"
  if TAGAVE_REQUIRE_SIGNATURE=1 signed_run --dir "$work/unsigned2" --version 0.9.5 >"$work/unsigned2.log" 2>&1; then fail "unsigned: TAGAVE_REQUIRE_SIGNATURE=1 went ahead"; fi
  pass "a release without a manifest is pulled by tag with a warning, or refused with TAGAVE_REQUIRE_SIGNATURE=1"

  # Modules turned on in Settings > Modules survive a re-run of the installer.
  mkdir -p "$work/signed/modules"
  printf '{"services":{"dummy":{"image":"example.test/dummy:1.0","profiles":["dummy"]}}}\n' >"$work/signed/modules/dummy.yml"
  sed -i.orig -e 's/^COMPOSE_PROFILES=.*/&,dummy/' -e 's|^COMPOSE_FILE=.*|&:modules/dummy.yml|' "$work/signed/.env" && rm -f "$work/signed/.env.orig"
  printf 'TAGAVE_MODULE_DUMMY_TOKEN=abc\n' >>"$work/signed/.env"
  signed_run --dir "$work/signed" --version 0.10.0 >"$work/signed2.log" 2>&1 || { cat "$work/signed2.log" >&2; fail "signed: re-run"; }
  [ "$(env_value COMPOSE_PROFILES "$work/signed/.env")" = "app,files,dummy" ] || fail "re-run: the module profile was dropped ($(env_value COMPOSE_PROFILES "$work/signed/.env"))"
  [ "$(env_value COMPOSE_FILE "$work/signed/.env")" = "compose.yml:modules/dummy.yml" ] || fail "re-run: the module compose file was dropped"
  [ "$(env_value TAGAVE_MODULE_DUMMY_TOKEN "$work/signed/.env")" = "abc" ] || fail "re-run: the module's secret was dropped"
  [ "$(services "$work/signed")" = "app dummy postgres worker-files worker-identify " ] || fail "re-run: services are $(services "$work/signed")"
  pass "re-running the installer keeps the modules that are on, their compose files and secrets"

  # disable-module hands the data choices to the updater's module run: the
  # history (the player's listens) only together with the data.
  module_run() {
    PATH="$work/bin:$PATH" REAL_DOCKER="$real_docker" FAKE_LOG="$work/docker.log" FAKE_STATE="$work/state" \
      "$signed_src/install-tagave.sh" "$@" --yes --dir "$work/signed" </dev/null
  }
  : >"$work/docker.log"
  module_run disable-module player --delete-data --delete-history >"$work/mod-off.log" 2>&1 || { cat "$work/mod-off.log" >&2; fail "disable-module --delete-data --delete-history"; }
  grep -q 'cli.js module disable player --delete-data --delete-history$' "$work/docker.log" || { cat "$work/docker.log" >&2; fail "disable-module: the updater run did not get --delete-data --delete-history"; }
  : >"$work/docker.log"
  module_run disable-module player --delete-data >"$work/mod-off2.log" 2>&1 || { cat "$work/mod-off2.log" >&2; fail "disable-module --delete-data"; }
  grep -q 'cli.js module disable player --delete-data$' "$work/docker.log" || { cat "$work/docker.log" >&2; fail "disable-module: --delete-data alone was not passed as it is"; }
  : >"$work/docker.log"
  if module_run disable-module player --delete-history >"$work/mod-off3.log" 2>&1; then fail "disable-module: --delete-history without --delete-data went ahead"; fi
  grep -q -- '--delete-history goes with --delete-data' "$work/mod-off3.log" || { cat "$work/mod-off3.log" >&2; fail "disable-module: the refusal does not say why"; }
  grep -q 'cli.js module' "$work/docker.log" && fail "disable-module: refused, but the updater ran"
  pass "disable-module passes --delete-data and --delete-history on, and refuses the history without the data"
else
  echo "test-installer: skip signed releases (this openssl cannot check Ed25519 signatures)"
fi

# --- the parent layout -------------------------------------------------------
# pick_music_layout reads every host fact through a TAGAVE_TEST_* hook here,
# so these cases run the same on macOS and on Linux: the system
# (TAGAVE_TEST_UNAME_S), the mount table (_MOUNTINFO),
# /etc/fstab (_FSTAB), the parent's propagation (_PROPAGATION), Docker's data
# folder and security options (_DOCKER_ROOT, _DOCKER_SECURITY), the docker
# program's path (_DOCKER_PATH), and a folder listed in place of the parent
# (_PARENT_DIR). Every share is at 192.0.2.x, where nothing answers, so no
# music folder is looked at; each case waits 1 s for it. Only a writable
# install takes the parent, so lay adds --music-writable unless L_RW is set
# to empty.
esc_home="$(printf '%s' "$HOME" | sed 's/ /\\040/g')"
printf '%s\n' \
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw' \
  '60 22 0:60 / /mnt/music rw,relatime shared:20 - nfs4 192.0.2.10:/export/music rw,hard' \
  '61 22 0:61 / /mnt/backup rw,relatime shared:21 - nfs4 192.0.2.11:/export/backup rw,hard' \
  '62 22 0:62 / /music rw,relatime shared:22 - nfs4 192.0.2.10:/export/music rw,hard' \
  "63 22 0:63 / $esc_home/music rw,relatime shared:23 - nfs4 192.0.2.10:/export/music rw,hard" \
  '64 22 0:64 / /srv/media/music rw,relatime shared:24 - nfs4 192.0.2.10:/export/music rw,hard' \
  '65 22 0:65 / /data/nas/music rw,relatime shared:25 - nfs4 192.0.2.10:/export/music rw,hard' \
  '66 22 0:66 / /mnt/music+lossless rw,relatime shared:26 - nfs4 192.0.2.10:/export/music rw,hard' \
  "67 22 0:67 / $esc_work/inst/music rw,relatime shared:27 - nfs4 192.0.2.10:/export/music rw,hard" \
  '68 22 0:68 / /home/music rw,relatime shared:28 - nfs4 192.0.2.10:/export/music rw,hard' \
  '69 22 0:69 / /media/usb/music rw,relatime shared:29 - nfs4 192.0.2.10:/export/music rw,hard' \
  >"$work/mountinfo-layout"
: >"$work/fstab-none"
printf '%s\n' '# /etc/fstab' "192.0.2.20:/export/tunes  /mnt/music  nfs4  hard,_netdev,vers=4.2  0 0" >"$work/fstab-nonofail"
printf '%s\n' "192.0.2.20:/export/tunes  /mnt/music  nfs4  hard,nofail  0 0" >"$work/fstab-nonetdev"
printf '%s\n' "192.0.2.20:/export/tunes  /mnt/music  nfs4  hard,noauto  0 0" >"$work/fstab-noauto"
mkdir -p "$work/fsonly/music"
printf '%s\n' "192.0.2.20:/export/tunes  $esc_work/fsonly/music  nfs4  hard,_netdev,nofail,x-systemd.automount  0 0" >"$work/fstab-good"
# Folders listed in place of the parent: the music alone; the music next to a
# plain folder and a file; the music next to /mnt/backup, a mount point.
mkdir -p "$work/list-music/music" "$work/list-plain/music" "$work/list-plain/backup" "$work/list-mounts/music" "$work/list-mounts/backup"
: >"$work/list-plain/photos"
# layout_hooks: exports the host facts; L_* variables change one of them.
layout_hooks() {
  export TAGAVE_TEST_UNAME_S="${L_UNAME:-Linux}" \
    TAGAVE_TEST_PROPAGATION="${L_PROP:-shared}" TAGAVE_TEST_MOUNTINFO="${L_MI:-$work/mountinfo-layout}" \
    TAGAVE_TEST_FSTAB="${L_FSTAB:-$work/fstab-none}" TAGAVE_TEST_PARENT_DIR="${L_LIST:-$work/list-music}" \
    TAGAVE_TEST_DOCKER_ROOT="${L_ROOT:-/var/lib/docker}" TAGAVE_TEST_DOCKER_SECURITY="${L_SEC:-name=seccomp,profile=builtin name=cgroupns}" \
    TAGAVE_TEST_DOCKER_PATH="${L_DPATH:-/usr/bin/docker}" TAGAVE_TEST_SHARE_WAIT=1
}
# lay NAME ARGS...: the installer (--yes --no-start) with the hooks, into
# $work/lay-NAME, its output in $work/lay-NAME.log; --music-writable unless
# L_RW is empty.
lay() (
  layout_hooks
  if [ -n "${L_RW-1}" ]; then set -- "$@" --music-writable; fi
  run --role all --dir "$work/lay-$1" "${@:2}" >"$work/lay-$1.log" 2>&1
)
# parent_keys ENV: the parent layout's lines of ENV, as written.
parent_keys() {
  local k
  for k in TAGAVE_MUSIC_BIND_SOURCE TAGAVE_MUSIC_BIND_TARGET TAGAVE_PLAYER_BIND_TARGET TAGAVE_MUSIC_PROPAGATION TAGAVE_MUSIC_NAME TAGAVE_PLAYER_MUSIC_FOLDER; do
    grep -E "^$k=" "$1" || true
  done
}
# expect_parent NAME PARENT MUSIC: lay-NAME's .env has the six keys.
expect_parent() {
  local want
  want="$(printf "TAGAVE_MUSIC_BIND_SOURCE='%s'\nTAGAVE_MUSIC_BIND_TARGET=/mnt/.host\nTAGAVE_PLAYER_BIND_TARGET=/host\nTAGAVE_MUSIC_PROPAGATION=rslave\nTAGAVE_MUSIC_NAME='%s'\nTAGAVE_PLAYER_MUSIC_FOLDER='/host/%s'" "$2" "$3" "$3")"
  [ "$(parent_keys "$work/lay-$1/.env")" = "$want" ] \
    || { cat "$work/lay-$1.log" >&2; fail "layout $1: .env lacks the parent keys for $2: $(parent_keys "$work/lay-$1/.env")"; }
  grep -q 'Music folder mounted directly' "$work/lay-$1.log" && fail "layout $1: picked the parent but printed a reason to keep the music folder"
  return 0
}
# expect_direct NAME REASON: no parent key in lay-NAME's .env, and exactly one
# line, this one, says why.
expect_direct() {
  [ -z "$(parent_keys "$work/lay-$1/.env")" ] || fail "layout $1: wrote parent keys: $(parent_keys "$work/lay-$1/.env")"
  [ "$(count 'Music folder mounted directly' "$work/lay-$1.log")" = 1 ] \
    || { cat "$work/lay-$1.log" >&2; fail "layout $1: not one line on why the music folder stays"; }
  grep -qxF "  Music folder mounted directly: $2." "$work/lay-$1.log" \
    || { cat "$work/lay-$1.log" >&2; fail "layout $1: the reason is not: $2"; }
}
silent_line="Your music share isn't connected now. tagave starts anyway and picks it up when it's back."

lay main --music /mnt/music || { cat "$work/lay-main.log" >&2; fail "layout: an NFS /mnt/music failed the install"; }
expect_parent main /mnt music
grep -qF "$silent_line" "$work/lay-main.log" || { cat "$work/lay-main.log" >&2; fail "layout: a silent share in the parent layout is not explained"; }
grep -q "doesn't answer. Turn the NAS on" "$work/lay-main.log" && fail "layout: the parent layout still says the share stops the install"
got="$(render "$work/lay-main" | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]["worker-files"]
v = [v for v in s["volumes"] if v["type"] == "bind"][0]
print(v["source"], v["target"], str(v.get("read_only", False)).lower(), v.get("bind", {}).get("propagation"), s["environment"].get("TAGAVE_MUSIC_NAME"))')"
[ "$got" = "/mnt /mnt/.host false rslave music" ] || fail "layout: the installer's parent .env renders $got"
pass "layout: a writable NFS /mnt/music on Linux with shared propagation gets the parent keys, and compose binds /mnt on /mnt/.host, rslave"

# A read-only install keeps the music folder, before anything is listed or asked.
L_RW='' L_LIST="$work/list-plain" lay ro --music /mnt/music || fail "layout: a read-only install failed"
expect_direct ro "a read-only music folder stays read-only only when it is mounted directly"
grep -q 'also holds' "$work/lay-ro.log" && fail "layout: a read-only install listed the parent"
[ "$(env_value TAGAVE_MUSIC_MODE "$work/lay-ro/.env")" = ro ] || fail "layout: the read-only case is not read-only"
pass "layout: a read-only install on an NFS /mnt/music with shared propagation keeps the music folder"

# No folder test touches the music folder while the layout is picked.
(
  layout_hooks
  TAGAVE_SKIP_IMAGE_CHECK=1 bash -x "$installer" --yes --no-start --version edge --timezone UTC \
    --role all --dir "$work/lay-trace" --music /mnt/music --music-writable </dev/null >"$work/lay-trace.log" 2>"$work/lay-trace.trace"
) || { cat "$work/lay-trace.log" >&2; fail "layout: the traced run failed"; }
expect_parent trace /mnt music
# A test operator ([ -d, test -e, [[ -r ...) or ls, stat, cd, find, readlink
# or realpath, with any options, given /mnt/music or a path inside it.
touch_re="(-[defrxsLh]|(^|[ +'])(ls|stat|cd|find|readlink|realpath))( +[^ /'][^ ]*)* +'?/mnt/music('|\$| |/)"
grep -E -- "$touch_re" "$work/lay-trace.trace" \
  && fail "layout: a folder test touched /mnt/music"
grep -qF -- 'local dir=/mnt/music' "$work/lay-trace.trace" || fail "layout: the trace does not show the layout being picked"
pass "layout: picking the parent never tests, lists or enters the music folder"

# A re-run decides again: with private propagation the keys go.
L_PROP=private lay main --music /mnt/music || fail "layout: private propagation failed the install"
expect_direct main "mounts under /mnt do not reach the parts (its mount is private, not shared)"
L_UNAME=Darwin lay mac --music /mnt/music || fail "layout: macOS failed the install"
expect_direct mac "this computer is not Linux"
pass "layout: a re-run decides again; private propagation and macOS keep the music folder, each with its reason"

L_PROP=' ' lay nofindmnt --music /mnt/music || fail "layout: findmnt without an answer failed the install"
expect_direct nofindmnt "tagave can't tell whether mounts under /mnt reach the parts (findmnt gave no answer)"
pass "layout: findmnt without an answer keeps the music folder"

lay root --music /music || fail "layout: /music failed the install"
expect_direct root "the folder above it, /, is too wide to share"
lay root2 --music /music --music-parent / || fail "layout: --music-parent / failed the install"
expect_direct root2 "the folder above it, /, is too wide to share"
lay home --music "$HOME/music" --music-parent "$HOME" || fail "layout: --music-parent \$HOME failed the install"
expect_direct home "the folder above it, $HOME, is your home folder"
lay home2 --music /home/music --music-parent /home || fail "layout: --music-parent /home failed the install"
expect_direct home2 "the folder above it, /home, is too wide to share"
L_ROOT=/srv lay indroot --music /srv/media/music || fail "layout: a parent inside Docker's data failed the install"
expect_direct indroot "the folder above it, /srv/media, is inside Docker's data"
lay inst --music "$work/inst/music" --music-parent "$work/inst" --dir "$work/inst/tagave" || fail "layout: the install folder case failed"
mv "$work/inst/tagave" "$work/lay-inst"
expect_direct inst "the folder above it, $work/inst, holds the install folder"
L_ROOT=/mnt/docker lay droot --music /mnt/music || fail "layout: Docker's data under /mnt failed the install"
expect_direct droot "the folder above it, /mnt, holds Docker's data"
lay odd --music /mnt/music+lossless || fail "layout: an odd name failed the install"
expect_direct odd "the music folder's name, music+lossless, has characters tagave can't use there"
pass "layout: /, the home folder, the install folder, Docker's data and an odd name keep the music folder"

lay srv --music /srv/media/music --music-parent /srv/media || fail "layout: --music-parent /srv/media failed the install"
expect_parent srv /srv/media music
lay media --music /media/usb/music || fail "layout: /media/usb/music failed the install"
expect_parent media /media/usb music
lay data --music /data/nas/music || { cat "$work/lay-data.log" >&2; fail "layout: /data/nas/music failed the install"; }
expect_direct data "the folder above it, /data/nas, is not under /mnt, /media or /srv (name it with --music-parent)"
lay data2 --music /data/nas/music --music-parent /data/nas || fail "layout: --music-parent /data/nas failed the install"
expect_parent data2 /data/nas music
lay nested --music /srv/media/music --music-parent /srv || fail "layout: --music-parent /srv failed the install"
expect_direct nested "--music-parent /srv is not the folder right above /srv/media/music"
lay forced --music /mnt/music --music-direct || fail "layout: --music-direct failed the install"
expect_direct forced "you asked for it with --music-direct"
[ "$(env_value TAGAVE_MUSIC_LAYOUT "$work/lay-forced/.env")" = direct ] || fail "layout: --music-direct did not write TAGAVE_MUSIC_LAYOUT=direct"
# A later plain re-run keeps it; a run with --music-parent picks again.
lay forced --music /mnt/music || fail "layout: the re-run after --music-direct failed"
expect_direct forced "you asked for it with --music-direct"
[ "$(env_value TAGAVE_MUSIC_LAYOUT "$work/lay-forced/.env")" = direct ] || fail "layout: a re-run dropped TAGAVE_MUSIC_LAYOUT=direct"
lay forced --music /mnt/music --music-parent /mnt || fail "layout: --music-parent after --music-direct failed"
expect_parent forced /mnt music
grep -q '^TAGAVE_MUSIC_LAYOUT=' "$work/lay-forced/.env" && fail "layout: --music-parent kept TAGAVE_MUSIC_LAYOUT"
if lay both --music /mnt/music --music-direct --music-parent /mnt; then fail "layout: took --music-direct with --music-parent"; fi
grep -qF -- "--music-parent and --music-direct don't go together; pick one" "$work/lay-both.log" || fail "layout: the two flags together are not explained"
pass "layout: --music-parent names the parent (the folder right above only); --music-direct writes only TAGAVE_MUSIC_LAYOUT=direct, kept until --music-parent"

lay plainfolder --music "$work/music" --music-parent "$work" || fail "layout: a plain folder failed the install"
expect_direct plainfolder "the music folder $work/music is not a mount point or an fstab entry"
L_FSTAB="$work/fstab-good" lay fsonly --music "$work/fsonly/music" --music-parent "$work/fsonly" || fail "layout: an fstab entry failed the install"
expect_parent fsonly "$work/fsonly" music
grep -q 'never edits fstab' "$work/lay-fsonly.log" && fail "layout: advised on an fstab line that has nofail and _netdev"
L_SEC='name=seccomp,profile=builtin name=rootless name=cgroupns' lay rootless --music /mnt/music || fail "layout: rootless failed the install"
expect_direct rootless "Docker runs rootless"
L_DPATH=/snap/bin/docker lay snap --music /mnt/music || fail "layout: snap failed the install"
expect_direct snap "Docker is the snap package, which only sees some folders"
pass "layout: a plain folder, rootless and snap Docker keep the music folder; an fstab entry counts as a mount"

listing="  The folder above your music, /mnt, also holds: backup, photos"
L_LIST="$work/list-plain" lay plain --music /mnt/music || fail "layout: a parent with a plain folder failed the install"
expect_direct plain "/mnt also holds folders that are not mounts, and there is no terminal to ask"
grep -qxF "$listing" "$work/lay-plain.log" || { cat "$work/lay-plain.log" >&2; fail "layout: the other entries are not listed by name"; }
L_LIST="$work/list-mounts" lay mounts --music /mnt/music || fail "layout: a parent with mount points failed the install"
expect_parent mounts /mnt music
grep -qxF "  The folder above your music, /mnt, also holds: backup" "$work/lay-mounts.log" || fail "layout: the mount point next to the music is not listed"
# On a terminal: the list once, one question; y takes the parent, n keeps the music folder.
lay_tty() (
  layout_hooks
  export TAGAVE_TEST_PARENT_DIR="$work/list-plain" TAGAVE_WITH_UPDATER=0 TAGAVE_WITH_PLAYER=0 TAGAVE_SKIP_IMAGE_CHECK=1
  on_terminal "$1" "$work/lay-$2.log" "$installer" --no-start --version edge --timezone UTC --port 3100 \
    --role all --dir "$work/lay-$2" --music /mnt/music --music-writable
)
question="Let tagave see all of /mnt? (y/N)"
lay_tty y tty-yes || { cat "$work/lay-tty-yes.log" >&2; fail "layout: the terminal yes failed the install"; }
[ "$(count "$question" "$work/lay-tty-yes.log")" = 1 ] || { cat "$work/lay-tty-yes.log" >&2; fail "layout: the terminal was not asked once"; }
[ "$(count "${listing#  }" "$work/lay-tty-yes.log")" = 1 ] || fail "layout: the terminal did not see the list once"
grep -q '/mnt/backup\|/mnt/photos' "$work/lay-tty-yes.log" && fail "layout: the list shows paths, not names"
expect_parent tty-yes /mnt music
lay_tty n tty-no || { cat "$work/lay-tty-no.log" >&2; fail "layout: the terminal no failed the install"; }
[ "$(count "$question" "$work/lay-tty-no.log")" = 1 ] || fail "layout: the terminal was not asked once before a no"
[ -z "$(parent_keys "$work/lay-tty-no/.env")" ] || fail "layout: a no on the terminal wrote parent keys"
grep -qF 'Music folder mounted directly: you chose not to share all of /mnt.' "$work/lay-tty-no.log" || fail "layout: a no on the terminal is not explained"
pass "layout: the other entries of the parent are listed by name; a terminal is asked once, without one a plain folder keeps the music folder"

L_FSTAB="$work/fstab-nonofail" lay advice --music /mnt/music || fail "layout: the fstab advice case failed the install"
expect_parent advice /mnt music
[ "$(count '192.0.2.10:/export/music  /mnt/music  nfs4  hard,_netdev,nofail,x-systemd.automount,x-systemd.mount-timeout=30  0 0' "$work/lay-advice.log")" = 1 ] \
  || { cat "$work/lay-advice.log" >&2; fail "layout: an fstab line without nofail does not get the suggested line once"; }
[ "$(count 'has no nofail, so this computer may wait or stop at boot while the NAS is off.' "$work/lay-advice.log")" = 1 ] || fail "layout: the advice does not say why"
grep -q '192.0.2.20\|export/tunes\|vers=4.2' "$work/lay-advice.log" && fail "layout: the advice printed the owner's own fstab line"
L_FSTAB="$work/fstab-nonetdev" lay netdev --music /mnt/music || fail "layout: the _netdev advice case failed the install"
[ "$(count 'has no _netdev, so the share may be mounted before the network is up.' "$work/lay-netdev.log")" = 1 ] \
  || { cat "$work/lay-netdev.log" >&2; fail "layout: an NFS line with nofail but no _netdev does not get its own reason"; }
grep -q 'has no nofail' "$work/lay-netdev.log" && fail "layout: a line with nofail was told it has none"
[ "$(count '192.0.2.10:/export/music  /mnt/music  nfs4' "$work/lay-netdev.log")" = 1 ] || fail "layout: the _netdev advice lacks the suggested line"
# A space in the music folder's path is written as \040, as fstab has it.
mkdir -p "$work/fs space/music"
printf '%s\n' "192.0.2.20:/export/tunes  $esc_work/fs\\040space/music  nfs4  hard  0 0" >"$work/fstab-space"
L_FSTAB="$work/fstab-space" lay space --music "$work/fs space/music" || { cat "$work/lay-space.log" >&2; fail "layout: the advice with a space failed the install"; }
[ "$(count "192.0.2.10:/export/music  $esc_work/fs\\040space/music  nfs4  hard,_netdev,nofail" "$work/lay-space.log")" = 1 ] \
  || { cat "$work/lay-space.log" >&2; fail "layout: the advice does not write the space as \\040"; }
L_FSTAB="$work/fstab-noauto" lay noauto --music /mnt/music || fail "layout: the noauto case failed the install"
grep -q 'never edits fstab' "$work/lay-noauto.log" && fail "layout: advised on a noauto line"
pass "layout: fstab advice: no nofail and no _netdev each say why, with the suggested line once (192.0.2.10); noauto gets none"

# Without --no-start: a silent share in the parent layout starts tagave anyway.
: >"$work/docker.log"
(
  layout_hooks
  TAGAVE_SKIP_IMAGE_CHECK=1 fake --yes --version 0.4.1 --timezone UTC --role all --dir "$work/lay-start" --music /mnt/music --music-writable
) >"$work/lay-start.log" 2>&1 || { cat "$work/lay-start.log" >&2; fail "layout: a silent share in the parent layout failed the install"; }
expect_parent start /mnt music
grep -qF "$silent_line" "$work/lay-start.log" || fail "layout: the start does not explain the silent share"
grep -q 'tagave starts once the share answers' "$work/lay-start.log" && fail "layout: the parent layout waited for the share"
[ -n "$(line_of 'compose up -d')" ] || { cat "$work/lay-start.log" >&2; fail "layout: the parent layout did not start tagave on a silent share"; }
pass "layout: a silent share in the parent layout says so and the install goes on"

# The two cases that wait the installer's full limits ran in the background.
check_silent_share
check_silent_docker
echo "test-installer: all roles pass"

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
run --role all --music-writable --dir "$work/rw" --music "$work/music" >"$work/rw.log" 2>&1 \
  || { cat "$work/rw.log" >&2; fail "--music-writable"; }
[ "$(env_value TAGAVE_MUSIC_MODE "$work/rw/.env")" = "rw" ] || fail "--music-writable: TAGAVE_MUSIC_MODE"
render "$work/rw" | grep -q '"read_only": true' && fail "--music-writable: the music mount is still read-only"
run --role all --dir "$work/rw" --music "$work/music" >"$work/rw2.log" 2>&1 \
  || { cat "$work/rw2.log" >&2; fail "--music-writable, re-run"; }
[ "$(env_value TAGAVE_MUSIC_MODE "$work/rw/.env")" = "rw" ] || fail "--music-writable: a re-run lost rw"
pass "--music-writable mounts the music read-write and keeps it on a re-run"

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
[ "$got" = "deluan/navidrome:0.64.0 ['4533'] True volume player-data false false false ['app', 'player']" ] \
  || fail "--with-player: the player must run the pinned image on port 4533, read the music read-only, keep its data in the player-data volume, with sharing, insights and Jellyfin off, and only the app and the player may get the password (got: $got)"
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
# Empty when nothing matches (grep's exit status would end the script under pipefail).
line_of() { { grep -nx -- "$1" "$work/docker.log" || true; } | head -n 1 | cut -d: -f1; }

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
if [ -z "$dump_at" ] || [ -z "$stop_at" ] || [ -z "$app_at" ] || [ -z "$rest_at" ]; then
  cat "$work/docker.log" >&2; fail "update: missing backup, stop or start calls"
fi
if ! { [ "$dump_at" -lt "$stop_at" ] && [ "$stop_at" -lt "$app_at" ] && [ "$app_at" -lt "$rest_at" ]; }; then
  cat "$work/docker.log" >&2; fail "update: expected backup, stop workers, start app, then the rest"
fi
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

# The player: a release that pins another Navidrome copies its data first.
at_version 0.4.1 --role all --with-player --dir "$work/upd-pl" --music "$work/music" >"$work/upd-pl-install.log" 2>&1 \
  || { cat "$work/upd-pl-install.log" >&2; fail "update player: install 0.4.1"; }
sed 's|deluan/navidrome:0\.64\.0|deluan/navidrome:0.63.0|' "$work/upd-pl/compose.yml" >"$work/upd-pl/compose.yml.new" \
  && mv "$work/upd-pl/compose.yml.new" "$work/upd-pl/compose.yml"
printf '0.4.1' >"$work/state/version"
fake status --dir "$work/upd-pl" >"$work/upd-pl-status.log" 2>&1 || { cat "$work/upd-pl-status.log" >&2; fail "status with the player"; }
grep -q 'Player: *healthy (port 4533)' "$work/upd-pl-status.log" || fail "status: does not show the player"
: >"$work/docker.log"
fake update --dir "$work/upd-pl" --yes >"$work/upd-pl.log" 2>&1 || { cat "$work/upd-pl.log" >&2; fail "update with a new player image"; }
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

echo "test-installer: all roles pass"

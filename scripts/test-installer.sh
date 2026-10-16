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
case "$1" in
  info) exit 0 ;;
  version) echo 27.0.0; exit 0 ;;
  manifest) echo '{"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'; exit 0 ;;
  inspect)
    case "$*" in
      *Config.Env*)
        [ -z "${FAKE_PG_USER:-}" ] || printf 'POSTGRES_USER=%s\nPOSTGRES_DB=%s\n' "$FAKE_PG_USER" "$FAKE_PG_USER"
        [ "${FAKE_APP_DOWN:-0}" = "1" ] || printf 'NODE_ENV=production\n%s=%s\n' "${FAKE_VERSION_VAR:-TAGAVE_BUILD_VERSION}" "$(cat "$FAKE_STATE/version")" ;;
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

: >"$work/docker.log"
fake update --dir "$work/upd" --yes >"$work/update.log" 2>&1 || { cat "$work/update.log" >&2; fail "update"; }
[ "$(env_value TAGAVE_VERSION "$work/upd/.env")" = "0.5.0" ] || fail "update: .env not moved to 0.5.0"
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
else
  echo "test-installer: skip signed releases (this openssl cannot check Ed25519 signatures)"
fi

echo "test-installer: all roles pass"

#!/usr/bin/env bash
#
# tagave installer: sets up tagave from the published container images.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/xooxoxxo/tagave/main/install-tagave.sh)"
#
# Options go after a placeholder word:  bash -c "$(curl ...)" _ --role app
#
# or, from a checkout:  ./install-tagave.sh
#
# Three roles, one per computer:
#
#   all    everything on this computer (the default)
#   app    database, web app and identify worker; the file worker runs on the
#          computer that can see your music (split install, part 1)
#   files  only the file worker, next to your music; it connects to the
#          database on the app computer (split install, part 2)
#
# Every question has a flag, so the installer also runs unattended:
#
#   ./install-tagave.sh --yes --music /srv/music
#   ./install-tagave.sh --yes --role app --advertise-address 192.168.1.10
#   ./install-tagave.sh --yes --role files --from files-worker.env --music /mnt/nas/music
#
# Re-running it is safe: secrets already in .env are kept, never replaced.
# The version is pinned in .env (TAGAVE_VERSION=0.5.0), so a pull never moves
# an install to a new release by surprise. To move it:
#
#   ./install-tagave.sh status              what runs here, and whether a release is out
#   ./install-tagave.sh update              back up, move to the newest release, check health
#   ./install-tagave.sh update --version 0.5.0 --yes
#
# Run with --help for every option.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (each can also come from the environment)
# ---------------------------------------------------------------------------

TAGAVE_REPO="${TAGAVE_REPO:-xooxoxxo/tagave}"
# Git ref the compose files come from when the script is piped in. Unset, it
# follows the image version (release 0.2.0 -> tag v0.2.0, edge -> main).
TAGAVE_REF="${TAGAVE_REF:-}"
TAGAVE_REGISTRY="${TAGAVE_REGISTRY:-ghcr.io/xooxoxxo}"
# Where the newest release is looked up (GitHub's releases API; /latest skips
# pre-releases). Tests point it at a file:// folder.
TAGAVE_RELEASES_API="${TAGAVE_RELEASES_API:-https://api.github.com/repos/$TAGAVE_REPO/releases}"

ROLE="${TAGAVE_ROLE:-}"
INSTALL_DIR="${TAGAVE_DIR:-$HOME/tagave}"
MUSIC_DIR="${TAGAVE_MUSIC_DIR:-}"
PORT="${TAGAVE_PORT:-}"
VERSION="${TAGAVE_VERSION:-}"
TIMEZONE="${TAGAVE_TZ:-}"
ADVERTISE_ADDRESS="${TAGAVE_ADVERTISE_ADDRESS:-}"
DB_HOST="${TAGAVE_DB_HOST:-}"
DB_PORT="${TAGAVE_DB_PORT:-}"
DB_BIND="${TAGAVE_DB_BIND:-}"
FROM_FILE="${TAGAVE_FROM:-}"
BEHIND_HTTPS="${TAGAVE_BEHIND_HTTPS:-}"
BACKUP_DIR="${TAGAVE_BACKUP_DIR:-}"
ASSUME_YES="${TAGAVE_YES:-0}"
NO_START=0
PLATFORM=""
REPLACE_SECRETS=0
VERSION_FROM_ENV_FILE=0
APP_URL="${TAGAVE_APP_URL:-}"
DRY_RUN=0
COMMAND="install"

PROJECT_NAME="tagave"
COMPOSE_MAIN="compose.yml"
COMPOSE_DB="compose.db-published.yml"
WORKER_ENV_NAME="files-worker.env"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''; C_OFF=''
fi

say()     { printf '%s\n' "$*"; }
step()    { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
ok()      { printf '%s  ok%s  %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn()    { printf '%s  !!%s  %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
# ON_DIE names a function that explains how to undo a half-done update; it is
# set only while update is changing things.
ON_DIE=""
die() {
  printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2
  if [ -n "$ON_DIE" ]; then local handler="$ON_DIE"; ON_DIE=""; "$handler" >&2; fi
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-tagave.sh [install|update|status] [options]

  install                  set up or reconfigure tagave here (the default)
  update                   move this install to a new release: back up the
                           database, pin the new version, pull, restart the
                           app and then the workers, wait until healthy, and
                           print how to roll back
  status                   what runs here, its health, and whether a newer
                           release is out

  --role all|app|files     what runs on this computer (default: all)
  --dir PATH               install directory (default: ~/tagave)
  --music PATH             your music folder on this computer (roles all, files)
  --port N                 web app port on this computer (default: 3100)
  --version TAG            release to run, e.g. 0.5.0 (default: the newest
                           release, written to .env as its number)
  --timezone ZONE          e.g. Europe/Berlin (default: this computer's, or UTC)
  --behind-https           the app will sit behind an https reverse proxy

  Split install, database computer (--role app):
  --advertise-address A    address the file worker uses to reach this computer
  --db-port N              port Postgres is published on (default: 5432)
  --db-bind ADDR           local address Postgres listens on (default: the
                           advertise address; 0.0.0.0 means every network)

  Split install, music computer (--role files):
  --from FILE              files-worker.env written by the app computer
  --db-host A              address of the app computer (if not using --from)
  --replace-secrets        let --from replace secrets already in this .env
  --app-url URL            where the app answers, e.g. http://192.168.1.10:3100.
                           update and status on the music computer ask it for
                           the app's version (default: from files-worker.env)

  update only:
  --dry-run                show what the update would do; change nothing

  --yes, -y                never ask; use flags, environment and defaults
  --no-start               write the configuration and check it, start nothing
  --help, -h               this text

Each option can also be set as an environment variable: TAGAVE_ROLE,
TAGAVE_DIR, TAGAVE_MUSIC_DIR, TAGAVE_PORT, TAGAVE_VERSION, TAGAVE_TZ,
TAGAVE_ADVERTISE_ADDRESS, TAGAVE_DB_HOST, TAGAVE_DB_PORT, TAGAVE_DB_BIND,
TAGAVE_FROM, TAGAVE_APP_URL, TAGAVE_BEHIND_HTTPS=1, TAGAVE_BACKUP_DIR, TAGAVE_YES=1. TAGAVE_REF picks the git
ref the compose files are downloaded from (default: the release being installed).
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value (see --help)"; fi; }

case "${1:-}" in
  install|update|status) COMMAND="$1"; shift ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)              need_arg "$@"; ROLE="$2"; shift 2 ;;
    --dir)               need_arg "$@"; INSTALL_DIR="$2"; DIR_GIVEN=1; shift 2 ;;
    --music)             need_arg "$@"; MUSIC_DIR="$2"; shift 2 ;;
    --port)              need_arg "$@"; PORT="$2"; shift 2 ;;
    --version)           need_arg "$@"; VERSION="$2"; shift 2 ;;
    --timezone)          need_arg "$@"; TIMEZONE="$2"; shift 2 ;;
    --advertise-address) need_arg "$@"; ADVERTISE_ADDRESS="$2"; shift 2 ;;
    --db-host)           need_arg "$@"; DB_HOST="$2"; shift 2 ;;
    --db-port)           need_arg "$@"; DB_PORT="$2"; shift 2 ;;
    --db-bind)           need_arg "$@"; DB_BIND="$2"; shift 2 ;;
    --from)              need_arg "$@"; FROM_FILE="$2"; shift 2 ;;
    --app-url)           need_arg "$@"; APP_URL="$2"; shift 2 ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --behind-https)      BEHIND_HTTPS=1; shift ;;
    --replace-secrets)   REPLACE_SECRETS=1; shift ;;
    --yes|-y)            ASSUME_YES=1; shift ;;
    --no-start)          NO_START=1; shift ;;
    --help|-h)           usage; exit 0 ;;
    *)                   die "unknown option: $1 (see --help)" ;;
  esac
done

# The copy the installer keeps in the install folder works on that folder
# when neither --dir nor TAGAVE_DIR names another one, so
# "./install-tagave.sh status" also works in an install made with --dir.
if [ -z "${TAGAVE_DIR:-}" ] && [ "${DIR_GIVEN:-0}" != 1 ] \
   && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$self_dir/.env" ] && [ -f "$self_dir/$COMPOSE_MAIN" ]; then
    INSTALL_DIR="$self_dir"
  fi
  unset self_dir
fi

# Questions go to the terminal even when the script itself arrives on stdin
# (curl ... | bash). Without a terminal, or with --yes, nothing is asked.
TTY=""
if [ "$ASSUME_YES" != "1" ] && { : </dev/tty; } 2>/dev/null; then
  TTY=/dev/tty
fi

# ask VAR "Question" default — sets VAR unless it already has a value.
ask() {
  local var="$1" question="$2" default="${3:-}" answer=""
  if [ -n "${!var}" ]; then return 0; fi
  if [ -n "$TTY" ]; then
    if [ -n "$default" ]; then
      printf '%s [%s]: ' "$question" "$default" >"$TTY"
    else
      printf '%s: ' "$question" >"$TTY"
    fi
    IFS= read -r answer <"$TTY" || answer=""
  fi
  answer="${answer:-$default}"
  printf -v "$var" '%s' "$answer"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Reads KEY from an env file without executing it. Strips one pair of
# surrounding single or double quotes.
env_get() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  value="${line#*=}"
  case "$value" in
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

# 32 random bytes as base64 (44 characters): the app secret.
generate_secret() {
  local secret
  secret="$(openssl rand -base64 32 | tr -d '\n')"
  [ -n "$secret" ] || die "could not generate a secret with openssl"
  printf '%s' "$secret"
}

# 32 random bytes as hex (64 characters): the database password. It sits
# inside a postgres:// URL, where base64's + / = would need escaping.
generate_password() {
  local secret
  secret="$(openssl rand -hex 32 | tr -d '\n')"
  [ -n "$secret" ] || die "could not generate a password with openssl"
  printf '%s' "$secret"
}

# A value we are about to write into .env: one line, no single quote.
check_value() {
  local name="$1" value="$2"
  case "$value" in
    *"'"*) die "$name cannot contain a single quote: $value" ;;
  esac
  case "$value" in
    *$'\n'*) die "$name cannot span several lines" ;;
  esac
}

# Versions: "v0.5.0" and "0.5.0" are the same release; images are tagged
# without the v.
normalize_version() {
  case "$1" in
    v[0-9]*) printf '%s' "${1#v}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# A tag goes into .env and into a sed expression: letters, digits, . _ - only.
check_tag() {
  case "$1" in
    *[!A-Za-z0-9._-]*) die "'$1' is not a valid version (expected something like 0.5.0)" ;;
  esac
}

is_release() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# version_lt A B: true when release A is older than release B.
version_lt() {
  local IFS=. i
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    if [ "${a[i]}" -lt "${b[i]}" ]; then return 0; fi
    if [ "${a[i]}" -gt "${b[i]}" ]; then return 1; fi
  done
  return 1
}

# fetch_text URL: prints the body, or nothing when it cannot be fetched.
fetch_text() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 15 "$1" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=15 "$1" 2>/dev/null || true
  fi
}

# The newest stable release as a number (0.5.0), or nothing when GitHub
# cannot be reached or nothing is released yet.
latest_release() {
  local tag
  tag="$(fetch_text "$TAGAVE_RELEASES_API/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  tag="$(normalize_version "$tag")"
  if is_release "$tag"; then printf '%s' "$tag"; fi
}

release_notes_url() { printf 'https://github.com/%s/releases/tag/v%s' "$TAGAVE_REPO" "$1"; }

is_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

detect_address() {
  local addr=""
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [ -z "$addr" ] && command -v ipconfig >/dev/null 2>&1; then
    addr="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$addr" ]; then
    addr="$(hostname 2>/dev/null || echo localhost)"
  fi
  printf '%s' "$addr"
}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

# This computer's IPv4 addresses, one per line (none when it cannot tell).
local_addresses() {
  {
    if command -v ip >/dev/null 2>&1; then
      ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    elif command -v ifconfig >/dev/null 2>&1; then
      ifconfig 2>/dev/null | awk '$1 == "inet" {sub("addr:", "", $2); print $2}'
    fi
  } | grep -v '^127\.' | sort -u || true
}

is_local_address() { local_addresses | grep -qxF "$1"; }

detect_timezone() {
  local tz=""
  if [ -n "${TZ:-}" ]; then
    tz="$TZ"
  elif [ -r /etc/timezone ]; then
    tz="$(head -n 1 /etc/timezone)"
  elif [ -L /etc/localtime ]; then
    tz="$(readlink /etc/localtime | sed -n 's#.*/zoneinfo/##p')"
  fi
  printf '%s' "${tz:-UTC}"
}

# </dev/null: when the script arrives on stdin, stdin is the rest of it.
compose() { (cd "$INSTALL_DIR" && docker compose "$@" </dev/null); }

# manifest IMAGE: prints the image manifest. On failure it prints nothing,
# returns 1 and leaves docker's error in $MANIFEST_ERR_FILE for
# explain_missing_image.
MANIFEST_ERR_FILE=""
manifest() { docker manifest inspect "$1" 2>"${MANIFEST_ERR_FILE:-/dev/null}"; }

image_exists() { manifest "$1" >/dev/null; }

# Stops with the reason the last manifest lookup failed. A registry answers a
# private image and a missing one alike ("unauthorized", "denied" or
# "manifest unknown"), so only a network failure is told apart.
explain_missing_image() {
  local image="$1" err=""
  [ -z "$MANIFEST_ERR_FILE" ] || err="$(cat "$MANIFEST_ERR_FILE" 2>/dev/null || true)"
  case "$err" in
    *'no such host'*|*'dial tcp'*|*'i/o timeout'*|*'network is unreachable'*|*'connection refused'*|*'TLS handshake timeout'*)
      die "could not reach ${image%%/*}. Check this computer's internet connection (docker said: $err)" ;;
  esac
  die "the tagave image $image is not public or not published. This is not a problem with your computer: see https://github.com/$TAGAVE_REPO/blob/main/docs/install.md for other ways to install. If you were given access to the images, run 'docker login ${image%%/*}' and try again."
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

check_prerequisites() {
  step "Checking this computer"

  command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed. Install it from https://docs.docker.com/get-docker/ and run this again."
  docker info >/dev/null 2>&1 \
    || die "Docker is installed but not reachable. Start Docker, or add your user to the docker group, then run this again."
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"

  local compose_version major minor
  compose_version="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$compose_version" ] \
    || die "Docker Compose v2 is missing. Install the docker-compose-plugin package (or Docker Desktop)."
  compose_version="${compose_version#v}"
  major="${compose_version%%.*}"
  minor="${compose_version#*.}"; minor="${minor%%.*}"
  case "$major$minor" in *[!0-9]*|'') major=0; minor=0 ;; esac
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 20 ]; }; then
    die "Docker Compose $compose_version is too old; tagave needs 2.20 or newer."
  fi
  ok "Docker Compose $compose_version"

  command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate secrets. Install it and run this again."

  local parent free_kb
  parent="$INSTALL_DIR"
  while [ ! -d "$parent" ]; do parent="$(dirname "$parent")"; done
  free_kb="$(df -Pk "$parent" | awk 'NR==2 {print $4}')"
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 5242880 ]; then
    warn "Less than 5 GB free at $parent. Images, database and cover art need room to grow."
  fi
}

collect_answers() {
  local existing="$INSTALL_DIR/.env"
  local arg_db_host="$DB_HOST" arg_db_port="$DB_PORT" arg_version="$VERSION" arg_app_url="$APP_URL"

  # A previous install supplies the defaults for everything it recorded.
  if [ -f "$existing" ]; then
    [ -n "$ROLE" ]      || ROLE="$(env_get TAGAVE_ROLE "$existing")"
    [ -n "$MUSIC_DIR" ] || MUSIC_DIR="$(env_get MUSIC_DIR "$existing")"
    [ -n "$PORT" ]      || PORT="$(env_get TAGAVE_PORT "$existing")"
    if [ -z "$VERSION" ]; then
      VERSION="$(env_get TAGAVE_VERSION "$existing")"
      [ -z "$VERSION" ] || VERSION_FROM_ENV_FILE=1
    fi
    [ -n "$TIMEZONE" ]  || TIMEZONE="$(env_get TZ "$existing")"
    [ -n "$DB_HOST" ]   || DB_HOST="$(env_get DB_HOST "$existing")"
    [ -n "$DB_PORT" ]   || DB_PORT="$(env_get DB_PORT "$existing")"
    [ -n "$DB_BIND" ]   || DB_BIND="$(env_get DB_BIND "$existing")"
    [ -n "$BACKUP_DIR" ] || BACKUP_DIR="$(env_get TAGAVE_BACKUP_DIR "$existing")"
    [ -n "$BACKUP_DIR" ] || BACKUP_DIR="$(env_get BACKUP_DIR "$existing")"
    [ -n "$ADVERTISE_ADDRESS" ] || ADVERTISE_ADDRESS="$(env_get TAGAVE_ADVERTISE_ADDRESS "$existing")"
    [ -n "$APP_URL" ]   || APP_URL="$(env_get TAGAVE_APP_URL "$existing")"
    if [ -z "$BEHIND_HTTPS" ] && [ "$(env_get ALLOW_INSECURE_HTTP "$existing")" = "false" ]; then
      BEHIND_HTTPS=1
    fi
  fi

  step "Setup"
  if [ -z "$ROLE" ] && [ -n "$TTY" ]; then
    say "  What should run on this computer?"
    say "    all    everything (most people want this)"
    say "    app    database and web app; the file worker runs on the computer with your music"
    say "    files  only the file worker, connecting to an app computer set up earlier"
  fi
  ask ROLE "Role (all, app or files)" "all"
  case "$ROLE" in all|app|files) ;; *) die "role must be all, app or files, not '$ROLE'" ;; esac

  if [ "$ROLE" = "files" ]; then
    if [ -z "$FROM_FILE" ] && [ -z "$DB_HOST" ] && [ -n "$TTY" ]; then
      say "  The app computer wrote $WORKER_ENV_NAME into its install folder. Copy it here"
      say "  and give its path, or leave empty to enter the app computer's address yourself."
      ask FROM_FILE "Path to $WORKER_ENV_NAME" ""
    fi
    if [ -n "$FROM_FILE" ]; then
      [ -f "$FROM_FILE" ] || die "$FROM_FILE does not exist"
      # The file from the app computer beats what an earlier install
      # recorded here; an explicit flag beats both.
      local from_value
      from_value="$(env_get DB_HOST "$FROM_FILE")"
      DB_HOST="${arg_db_host:-${from_value:-$DB_HOST}}"
      from_value="$(env_get DB_PORT "$FROM_FILE")"
      DB_PORT="${arg_db_port:-${from_value:-$DB_PORT}}"
      from_value="$(env_get TAGAVE_VERSION "$FROM_FILE")"
      VERSION="${arg_version:-${from_value:-$VERSION}}"
      from_value="$(env_get TAGAVE_APP_URL "$FROM_FILE")"
      APP_URL="${arg_app_url:-${from_value:-$APP_URL}}"
      # The file worker runs the app computer's version, edge included.
      VERSION_FROM_ENV_FILE=0
    fi
    ask DB_HOST "Address of the app computer" ""
    [ -n "$DB_HOST" ] || die "a file worker needs the app computer's address: pass --from $WORKER_ENV_NAME or --db-host"
    ask DB_PORT "Database port on the app computer" "5432"
    is_port "$DB_PORT" || die "database port must be a number from 1 to 65535, not '$DB_PORT'"
  fi

  if [ "$ROLE" = "app" ]; then
    ask ADVERTISE_ADDRESS "Address the music computer uses to reach this one" "$(detect_address)"
    ask DB_PORT "Port to publish the database on" "5432"
    is_port "$DB_PORT" || die "database port must be a number from 1 to 65535, not '$DB_PORT'"
    settle_db_bind
  fi

  if [ "$ROLE" != "files" ]; then
    ask PORT "Web app port" "3100"
    is_port "$PORT" || die "port must be a number from 1 to 65535, not '$PORT'"
  fi

  if [ "$ROLE" != "app" ]; then
    local default_music=""
    [ -d /mnt/music ] && default_music="/mnt/music"
    if [ -n "$TTY" ] && [ -z "$MUSIC_DIR" ]; then
      say "  Your music folder on this computer. A network share (NFS, SMB) has to be"
      say "  mounted on this computer first; give the folder it is mounted on."
    fi
    ask MUSIC_DIR "Music folder" "$default_music"
    if [ -z "$MUSIC_DIR" ]; then
      MUSIC_DIR="$INSTALL_DIR/music"
      warn "No music folder given. Using the empty folder $MUSIC_DIR; point MUSIC_DIR in .env at your library later."
    fi
    case "$MUSIC_DIR" in /*) ;; *) MUSIC_DIR="$(cd "$MUSIC_DIR" 2>/dev/null && pwd || echo "$PWD/$MUSIC_DIR")" ;; esac
  fi

  ask TIMEZONE "Timezone" "$(detect_timezone)"

  check_value "install directory" "$INSTALL_DIR"
  check_value "music folder" "$MUSIC_DIR"
  check_value "timezone" "$TIMEZONE"
  check_value "address" "$ADVERTISE_ADDRESS$DB_HOST$DB_BIND"
  check_value "app address" "$APP_URL"
}

# Where the published Postgres listens. Docker publishes ports past ufw and
# firewalld on Linux, so "allow only the music computer in the firewall" does
# not work; listening on one address is what limits who can connect.
settle_db_bind() {
  local default_bind=""
  if [ -z "$DB_BIND" ]; then
    if is_ipv4 "$ADVERTISE_ADDRESS" && is_local_address "$ADVERTISE_ADDRESS"; then
      default_bind="$ADVERTISE_ADDRESS"
    fi
    if [ -n "$TTY" ]; then
      say "  The database listens on one address of this computer, so only networks"
      say "  that address is on can reach it. Pick your home network or VPN address"
      say "  (0.0.0.0 means every network this computer is on)."
    fi
    ask DB_BIND "Address the database listens on" "$default_bind"
  fi
  [ -n "$DB_BIND" ] \
    || die "pick the address the database listens on with --db-bind (an address of this computer that the music computer can reach, such as its home network or Tailscale address)."
  if [ "$DB_BIND" = "0.0.0.0" ]; then
    warn "The database will listen on every network this computer is on. On Linux, Docker opens published ports past ufw and firewalld, so a firewall rule will not keep others out; see docs/install.md."
  elif ! is_ipv4 "$DB_BIND"; then
    die "--db-bind needs an IPv4 address of this computer, not '$DB_BIND'"
  elif local_addresses | grep -q . && ! is_local_address "$DB_BIND"; then
    die "$DB_BIND is not an address of this computer, so Docker cannot listen on it. Addresses here: $(local_addresses | tr '\n' ' ')"
  fi
}

check_music_dir() {
  [ "$ROLE" != "app" ] || return 0
  if [ "$MUSIC_DIR" = "$INSTALL_DIR/music" ]; then
    mkdir -p "$MUSIC_DIR"
  elif [ ! -d "$MUSIC_DIR" ]; then
    die "the music folder $MUSIC_DIR does not exist. Check the path, or mount the share first."
  elif [ ! -r "$MUSIC_DIR" ] || [ ! -x "$MUSIC_DIR" ]; then
    die "the music folder $MUSIC_DIR is not readable."
  fi
  ok "Music folder $MUSIC_DIR"
}

# Both images must exist under the tag. Sets PLATFORM when they are built
# for x86-64 only and this computer is ARM: Docker then runs them emulated.
resolve_version() {
  local tag="" release=""

  VERSION="$(normalize_version "$VERSION")"
  # "latest" floats: every pull could move the install to a new release. An
  # older installer wrote it to .env. Pin it to the release running here, so
  # re-running the installer never updates by the back door (no backup, no
  # workers stopped first). Moving to a newer release is "update".
  if [ "$VERSION" = "latest" ]; then
    VERSION=""
    if [ "$VERSION_FROM_ENV_FILE" = "1" ]; then
      local running
      running="$(installed_version latest)"
      if [ -n "$running" ]; then
        VERSION="$running"
        say "  .env said 'latest'; pinning it to $running, the version this install runs now."
        say "  To move to a newer release afterwards: ./install-tagave.sh update"
      else
        warn "Could not tell which version runs here, so .env is pinned to the newest release. If an older version was running, this starts the newer one without the backup that install-tagave.sh update takes."
      fi
    fi
  fi
  # An install that recorded edge before any release existed moves to the
  # stable release once one is published; an explicit --version stays put.
  if [ "$VERSION" = "edge" ] && [ "$VERSION_FROM_ENV_FILE" = "1" ] && [ "$ROLE" != "files" ]; then
    release="$(latest_release)"
    if [ -n "$release" ]; then
      VERSION=""
      say "  A stable release is out now; moving this install from edge to it."
    fi
  fi
  if [ -z "$VERSION" ]; then
    release="${release:-$(latest_release)}"
    VERSION="$release"
  fi
  check_tag "$VERSION"

  # For tests (scripts/test-installer.sh): trust the version without asking
  # the registry, so the configuration can be checked offline.
  if [ "${TAGAVE_SKIP_IMAGE_CHECK:-0}" = "1" ]; then
    [ -n "$VERSION" ] || die "TAGAVE_SKIP_IMAGE_CHECK=1 needs --version or a release at TAGAVE_RELEASES_API"
    ok "Version $VERSION (not checked against the registry)"
    return 0
  fi

  if [ -n "$VERSION" ]; then
    tag="$VERSION"
  elif image_exists "$TAGAVE_REGISTRY/tagave-app:latest"; then
    # GitHub did not answer, but a release exists. Say plainly that this
    # install then floats with every pull until it is pinned.
    tag="latest"
    warn "Could not look up the newest release number on GitHub, so .env gets the floating tag 'latest': a later 'docker compose pull' can move this install to a new release. Pin it with: install-tagave.sh update --version X.Y.Z"
  elif image_exists "$TAGAVE_REGISTRY/tagave-app:edge"; then
    tag="edge"
    warn "No stable release is published yet, so this installs the development build (edge)."
  else
    explain_missing_image "$TAGAVE_REGISTRY/tagave-app:edge"
  fi

  local app_manifest worker_manifest
  app_manifest="$(manifest "$TAGAVE_REGISTRY/tagave-app:$tag" || true)"
  [ -n "$app_manifest" ] || explain_missing_image "$TAGAVE_REGISTRY/tagave-app:$tag"
  worker_manifest="$(manifest "$TAGAVE_REGISTRY/tagave-worker:$tag" || true)"
  [ -n "$worker_manifest" ] || explain_missing_image "$TAGAVE_REGISTRY/tagave-worker:$tag"
  VERSION="$tag"
  ok "Version $VERSION"

  PLATFORM=""
  case "$(uname -m)" in
    arm64|aarch64)
      if ! printf '%s' "$app_manifest$worker_manifest" | grep -q '"arm64"'; then
        PLATFORM="linux/amd64"
        warn "This build has no ARM version yet; Docker will run the x86-64 one emulated, which is slower."
      fi
      ;;
  esac
}

fetch_compose_files() {
  step "Writing files to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"

  # From a checkout, use the files next to this script. Piped in through
  # curl, there is no script file, so fetch them from the same ref.
  local src="" name
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy"
    [ -f "$src/$COMPOSE_MAIN" ] || src=""
  fi

  local ref=""
  [ -n "$src" ] || ref="$(compose_ref)"
  for name in "$COMPOSE_MAIN" "$COMPOSE_DB"; do
    if [ -n "$src" ]; then
      cp "$src/$name" "$INSTALL_DIR/$name.tmp"
    elif ! download "https://raw.githubusercontent.com/$TAGAVE_REPO/$ref/deploy/$name" "$INSTALL_DIR/$name.tmp"; then
      # A release from before the installer has no deploy/ folder.
      { [ "$ref" != "main" ] && [ -z "$TAGAVE_REF" ]; } \
        || die "could not download deploy/$name from $TAGAVE_REPO at $ref"
      warn "Release $ref has no deploy/$name; using the one from main."
      ref="main"
      download "https://raw.githubusercontent.com/$TAGAVE_REPO/main/deploy/$name" "$INSTALL_DIR/$name.tmp" \
        || die "could not download deploy/$name from $TAGAVE_REPO"
    fi
    mv "$INSTALL_DIR/$name.tmp" "$INSTALL_DIR/$name"
  done
  if [ -n "$src" ]; then
    ok "$COMPOSE_MAIN, $COMPOSE_DB (from $src)"
  else
    ok "$COMPOSE_MAIN, $COMPOSE_DB (from $ref)"
  fi

  # Keep a copy of the installer next to them, so "install-tagave.sh update"
  # and "status" work from the install folder. Written to a new file and
  # moved into place, so a copy that is running right now is not disturbed.
  local self="$INSTALL_DIR/install-tagave.sh"
  if [ -n "$src" ]; then
    cp "${BASH_SOURCE[0]}" "$self.tmp" && chmod 755 "$self.tmp" && mv "$self.tmp" "$self"
  elif download "https://raw.githubusercontent.com/$TAGAVE_REPO/$ref/install-tagave.sh" "$self.tmp" 2>/dev/null \
       && { grep -q '^run_update()' "$self.tmp" \
            || download "https://raw.githubusercontent.com/$TAGAVE_REPO/main/install-tagave.sh" "$self.tmp" 2>/dev/null; }; then
    # A release from before "update" existed gets the current installer.
    chmod 755 "$self.tmp" && mv "$self.tmp" "$self"
  else
    rm -f "$self.tmp"
  fi
}

# download URL FILE
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "curl or wget is needed to download $1"
  fi
}

# The git ref whose deploy/ files match the images of VERSION: the release
# tag for a release, main for edge and anything else.
compose_ref() {
  local tag=""
  if [ -n "$TAGAVE_REF" ]; then printf '%s' "$TAGAVE_REF"; return 0; fi
  case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) printf 'v%s' "$VERSION" ;;
    latest)
      tag="$(latest_release)"
      if [ -n "$tag" ]; then printf 'v%s' "$tag"; else printf 'main'; fi
      ;;
    *) printf 'main' ;;
  esac
}

# Decides APP_SECRET and POSTGRES_PASSWORD. Existing ones always win, except
# on a file worker explicitly told to take new ones from --from.
settle_secrets() {
  local existing="$INSTALL_DIR/.env"
  APP_SECRET="$(env_get APP_SECRET "$existing")"
  POSTGRES_PASSWORD="$(env_get POSTGRES_PASSWORD "$existing")"
  POSTGRES_USER="$(env_get POSTGRES_USER "$existing")"
  POSTGRES_DB="$(env_get POSTGRES_DB "$existing")"
  POSTGRES_USER="${POSTGRES_USER:-liner}"
  POSTGRES_DB="${POSTGRES_DB:-liner}"

  if [ "$ROLE" = "files" ] && [ -n "$FROM_FILE" ]; then
    local new_secret new_password new_user new_db
    new_secret="$(env_get APP_SECRET "$FROM_FILE")"
    new_password="$(env_get POSTGRES_PASSWORD "$FROM_FILE")"
    new_user="$(env_get POSTGRES_USER "$FROM_FILE")"
    new_db="$(env_get POSTGRES_DB "$FROM_FILE")"
    if [ -z "$new_secret" ] || [ -z "$new_password" ]; then
      die "$FROM_FILE has no APP_SECRET or POSTGRES_PASSWORD; copy it again from the app computer"
    fi
    if { [ -n "$APP_SECRET" ] && [ "$APP_SECRET" != "$new_secret" ]; } \
       || { [ -n "$POSTGRES_PASSWORD" ] && [ "$POSTGRES_PASSWORD" != "$new_password" ]; }; then
      [ "$REPLACE_SECRETS" = "1" ] \
        || die "$INSTALL_DIR/.env already holds different secrets than $FROM_FILE. Re-run with --replace-secrets to use the new ones (the old .env is kept as a backup)."
      warn "Replacing the secrets in .env with the ones from $FROM_FILE."
    fi
    APP_SECRET="$new_secret"
    POSTGRES_PASSWORD="$new_password"
    POSTGRES_USER="${new_user:-liner}"
    POSTGRES_DB="${new_db:-liner}"
    return 0
  fi

  if [ "$ROLE" = "files" ]; then
    if [ -z "$APP_SECRET" ] || [ -z "$POSTGRES_PASSWORD" ]; then
      die "a file worker needs the app computer's secrets: pass --from $WORKER_ENV_NAME"
    fi
    return 0
  fi

  # A database volume without a password on record means the password that
  # opens it is lost from this folder; a new one would not match it.
  if [ -z "$POSTGRES_PASSWORD" ] && docker volume inspect "${PROJECT_NAME}_pgdata" >/dev/null 2>&1; then
    die "a tagave database already exists (docker volume ${PROJECT_NAME}_pgdata) but $existing has no POSTGRES_PASSWORD. Restore the .env you installed with; the installer will not create a new password that cannot open that database."
  fi

  if [ -z "$APP_SECRET" ]; then
    APP_SECRET="$(generate_secret)" || die "generating the app secret failed"
    [ -n "$APP_SECRET" ] || die "generating the app secret failed"
    ok "Generated a new app secret"
  else
    ok "Kept the app secret already in .env"
  fi
  if [ -z "$POSTGRES_PASSWORD" ]; then
    POSTGRES_PASSWORD="$(generate_password)" || die "generating the database password failed"
    [ -n "$POSTGRES_PASSWORD" ] || die "generating the database password failed"
    ok "Generated a new database password"
  else
    ok "Kept the database password already in .env"
  fi
}

# Writes stdin to a file readable only by the owner: created under umask 077
# next to the target, then moved into place. A previous, different version is
# kept as a private .bak copy; an identical one is left alone.
write_private() {
  local target="$1" tmp backup
  tmp="$target.tmp.$$"
  ( umask 077; cat >"$tmp" )
  chmod 600 "$tmp"
  if [ -f "$target" ]; then
    if cmp -s "$tmp" "$target"; then
      rm -f "$tmp"
      chmod 600 "$target"
      return 0
    fi
    backup="$target.bak.$(date +%Y%m%d-%H%M%S)"
    ( umask 077; cp "$target" "$backup" )
    chmod 600 "$backup"
    say "     previous $(basename "$target") saved as $(basename "$backup")"
  fi
  mv "$tmp" "$target"
}

write_env() {
  local env_file="$INSTALL_DIR/.env" profiles files insecure
  case "$ROLE" in
    all)   profiles="app,files"; files="$COMPOSE_MAIN" ;;
    app)   profiles="app";       files="$COMPOSE_MAIN:$COMPOSE_DB" ;;
    files) profiles="files";     files="$COMPOSE_MAIN" ;;
  esac
  if [ -z "$APP_SECRET" ] || [ -z "$POSTGRES_PASSWORD" ]; then
    die "refusing to write .env without an app secret and a database password"
  fi
  insecure="true"
  if [ "$BEHIND_HTTPS" = "1" ]; then insecure="false"; fi

  {
    cat <<EOF
# tagave configuration, written by install-tagave.sh.
# It holds the secrets that open your database and your stored provider
# tokens: keep a copy somewhere safe and never share it. Re-running the
# installer keeps these secrets.

# which services run on this computer (docker compose reads the first three lines)
COMPOSE_PROJECT_NAME=$PROJECT_NAME
COMPOSE_FILE=$files
COMPOSE_PROFILES=$profiles
TAGAVE_ROLE=$ROLE

# images: the release this install runs. Move it with install-tagave.sh update,
# which backs up the database first and prints how to go back.
TAGAVE_REGISTRY=$TAGAVE_REGISTRY
TAGAVE_VERSION=$VERSION

APP_SECRET=$APP_SECRET
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_USER=$POSTGRES_USER
POSTGRES_DB=$POSTGRES_DB

TZ='$TIMEZONE'
LOG_LEVEL=info
EOF
    if [ -n "$PLATFORM" ]; then
      printf '\n# the images of this version exist for x86-64 only\nDOCKER_DEFAULT_PLATFORM=%s\n' "$PLATFORM"
    fi
    if [ "$ROLE" != "files" ]; then
      printf '\n# web app\nTAGAVE_PORT=%s\nALLOW_INSECURE_HTTP=%s\n' "$PORT" "$insecure"
      if [ -n "$BACKUP_DIR" ]; then
        printf "\n# the app backs up the database here before every update that changes it,\n# and the nightly backups (Settings > Backups) go here too\nTAGAVE_BACKUP_DIR='%s'\n" "$BACKUP_DIR"
      else
        printf '\n# the app backs up the database before every update that changes it, into\n# the Docker volume "backups" with the nightly ones; set a folder here to keep\n# those backups outside Docker\n# TAGAVE_BACKUP_DIR=/path/to/backups\n'
      fi
    fi
    if [ "$ROLE" = "app" ]; then
      printf '\n# database published for the file worker on the music computer\nDB_BIND=%s\nDB_PORT=%s\nTAGAVE_ADVERTISE_ADDRESS=%s\n' \
        "$DB_BIND" "$DB_PORT" "$ADVERTISE_ADDRESS"
    fi
    if [ "$ROLE" = "files" ]; then
      printf '\n# database on the app computer\nDB_HOST=%s\nDB_PORT=%s\n' "$DB_HOST" "$DB_PORT"
      if [ -n "$APP_URL" ]; then
        printf '# the web app, asked for its version by install-tagave.sh update\nTAGAVE_APP_URL=%s\n' "$APP_URL"
      fi
    fi
    if [ "$ROLE" != "app" ]; then
      printf "\n# your music, mounted read-only at /mnt/music in the file worker\nMUSIC_DIR='%s'\n" "$MUSIC_DIR"
    fi
  } | write_private "$env_file"
  ok ".env (readable only by you)"

  if [ "$ROLE" = "app" ]; then
    local worker_env="$INSTALL_DIR/$WORKER_ENV_NAME"
    write_private "$worker_env" <<EOF
# tagave file worker settings, written by install-tagave.sh on the app computer.
# Copy this file to the computer that can see your music and run there:
#   ./install-tagave.sh --role files --from $WORKER_ENV_NAME --music /path/to/music
# It holds secrets: delete the copy once the file worker is installed.
DB_HOST=$ADVERTISE_ADDRESS
DB_PORT=$DB_PORT
TAGAVE_APP_URL=http://$ADVERTISE_ADDRESS:$PORT
TAGAVE_VERSION=$VERSION
APP_SECRET=$APP_SECRET
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_USER=$POSTGRES_USER
POSTGRES_DB=$POSTGRES_DB
EOF
    ok "$WORKER_ENV_NAME (for the music computer, readable only by you)"
  fi
}

validate_compose() {
  compose config --quiet || die "docker compose rejected the configuration in $INSTALL_DIR (see above)"
  ok "Compose configuration is valid"
}

# The file worker is useless if it cannot reach the database, so check the
# path before starting it, from inside the worker image.
check_db_reachable() {
  [ "$ROLE" = "files" ] || return 0
  step "Checking the connection to the app computer"
  compose pull --quiet worker-files || die "downloading the worker image failed (see above)."
  if compose run --rm --no-deps -T --entrypoint node worker-files -e "
      const s = require('net').connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 5000 });
      s.on('connect', () => { s.end(); process.exit(0); });
      s.on('timeout', () => process.exit(1));
      s.on('error', () => process.exit(1));
    " "$DB_HOST" "$DB_PORT" >/dev/null 2>&1; then
    ok "The database at $DB_HOST:$DB_PORT answers"
  else
    die "cannot reach the database at $DB_HOST:$DB_PORT. Check that the app computer is on, that its database listens on an address this computer can reach (DB_BIND in its .env), and that the address and port are right."
  fi
}

container_health() {
  local id
  id="$(compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$id" ] || { echo "missing"; return 0; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo "missing"
}

wait_for() {
  local service="$1" want="$2" seconds="$3" i=0 state
  while [ "$i" -lt "$seconds" ]; do
    state="$(container_health "$service")"
    [ "$state" = "$want" ] && return 0
    case "$state" in exited|dead|unhealthy) return 1 ;; esac
    sleep 2
    i=$((i + 2))
  done
  return 1
}

start_services() {
  step "Starting tagave"
  compose pull || die "downloading the images failed (see above). Fix that, then run this again."
  # The workers wait for the app to be healthy, so this returns once the app
  # has finished any database update (backup first, then migrations).
  if ! compose up -d; then
    [ "$ROLE" = "files" ] || compose logs --tail 40 app >&2 || true
    die "docker compose could not start tagave. The log above says why; fix it and run this again."
  fi

  if [ "$ROLE" != "files" ]; then
    say "  Waiting for the web app (the first start sets up the database)..."
    if wait_for app healthy 600; then
      ok "Web app is up"
    else
      compose logs --tail 40 app >&2 || true
      die "the web app did not become healthy. The log above says why; fix it and run the installer again."
    fi
  fi

  local worker
  for worker in worker-identify worker-files; do
    case "$ROLE:$worker" in app:worker-files|files:worker-identify) continue ;; esac
    wait_for_worker "$worker"
  done
  [ "$ROLE" = "app" ] || check_music_visible
}

# Docker on macOS (Docker Desktop, colima) runs containers in a VM and only
# sees the host folders it shares with that VM; colima shares only $HOME by
# default. A folder outside those is mounted as an empty directory without
# any error, and every scan then finds nothing. Compare the two sides.
check_music_visible() {
  local host_entry inside
  host_entry="$(find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1 || true)"
  [ -n "$host_entry" ] || return 0
  inside="$(compose exec -T worker-files find /mnt/music -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1 || true)"
  if [ -n "$inside" ]; then
    ok "The file worker can see your music"
    return 0
  fi
  warn "The file worker sees an empty /mnt/music, but $MUSIC_DIR has files in it."
  say "  Docker is not sharing that folder with its virtual machine, so scans will find nothing."
  if [ "$(uname -s)" = "Darwin" ]; then
    say "  Move the music under your home folder ($HOME), or add the folder to Docker's"
    say "  shared folders (Docker Desktop: Settings > Resources > File sharing;"
    say "  colima: the mounts list in ~/.colima/default/colima.yaml, then colima restart)."
  else
    say "  Check that the folder is not on a mount Docker cannot see (a rootless or snap Docker"
    say "  only sees some paths)."
  fi
  say "  Then run this installer again."
}

# A worker has no health endpoint; it logs "worker ready" once connected and
# restarts in a loop when it cannot get there (wrong password, bad secret).
wait_for_worker() {
  local worker="$1" i=0 id restarts logs
  say "  Waiting for $worker to connect..."
  while [ "$i" -lt 120 ]; do
    id="$(compose ps -q "$worker" 2>/dev/null || true)"
    logs="$(compose logs --no-log-prefix "$worker" 2>/dev/null || true)"
    case "$logs" in *'"msg":"worker ready"'*) ok "$worker is connected"; return 0 ;; esac
    restarts="$( [ -n "$id" ] && docker inspect --format '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)"
    if [ "${restarts:-0}" -gt 0 ]; then
      compose logs --tail 20 "$worker" >&2 || true
      case "$logs" in
        *'will not run:'*)
          die "$worker is older than the database: a newer app has already updated it. Install the same TAGAVE_VERSION as the app computer here and run this again." ;;
        *'password authentication failed'*)
          die "the database refused $worker's password. On a split install, $WORKER_ENV_NAME must come from the app install this worker joins." ;;
      esac
      die "$worker keeps restarting. The log above says why."
    fi
    sleep 3
    i=$((i + 3))
  done
  compose logs --tail 20 "$worker" >&2 || true
  die "$worker did not connect within two minutes. The log above says why."
}

show_summary() {
  step "Done"
  local addr
  addr="$(detect_address)"
  case "$ROLE" in
    all|app)
      say "  Open tagave:    http://localhost:$PORT"
      if [ "$addr" != "localhost" ]; then say "  From elsewhere: http://$addr:$PORT"; fi
      say ""
      say "  The first visit creates your account. When it asks for a scan root,"
      if [ "$ROLE" = "all" ]; then
        say "  enter /mnt/music: that is $MUSIC_DIR as the file worker sees it."
      else
        say "  enter /mnt/music: that is the music folder on the music computer."
      fi
      ;;
  esac
  if [ "$ROLE" = "app" ]; then
    say ""
    say "  Next, on the computer that can see your music:"
    say "    1. Copy $INSTALL_DIR/$WORKER_ENV_NAME there (it holds secrets; delete it afterwards)."
    say "    2. Run:  install-tagave.sh --role files --from $WORKER_ENV_NAME --music /path/to/music"
    say "  The database now listens on $DB_BIND port $DB_PORT."
    say "  On Linux a firewall rule does not cover it (Docker opens published ports"
    say "  past ufw and firewalld); docs/install.md shows how to limit it."
    say "  Until the file worker runs, scans wait in the queue."
  fi
  if [ "$ROLE" = "files" ]; then
    say "  The file worker is connected to $DB_HOST. Scans started in the app now run here,"
    say "  reading $MUSIC_DIR (the scan root /mnt/music)."
  fi
  say ""
  say "  In $INSTALL_DIR:"
  say "    docker compose ps                   what is running"
  say "    docker compose logs -f              live logs"
  if [ "$ROLE" != "files" ]; then
    say "    docker compose exec app node packages/doctor/dist/cli.js doctor    full health check"
    say "    docker compose exec app node packages/doctor/dist/cli.js backup    back up the database"
  fi
  say ""
  say "  This install runs tagave $VERSION, pinned in .env. To check for and move to a new release,"
  say "  in $INSTALL_DIR:"
  say "    ./install-tagave.sh status          version, health, and whether a release is out"
  say "    ./install-tagave.sh update          back up, update, check health (run it on every computer)"
  say ""
  say "  Keep a copy of $INSTALL_DIR/.env somewhere safe: without it the database cannot be opened."
}

main() {
  say "${C_BOLD}tagave installer${C_OFF}"
  check_value "install directory" "$INSTALL_DIR"
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac

  MANIFEST_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/tagave-manifest.XXXXXX")"
  trap 'rm -f "$MANIFEST_ERR_FILE"' EXIT

  check_prerequisites
  collect_answers
  check_music_dir
  resolve_version
  fetch_compose_files
  settle_secrets
  write_env
  validate_compose

  if [ "$NO_START" = "1" ]; then
    step "Configuration written; nothing started (--no-start)"
    say "  Start it with:  cd $INSTALL_DIR && docker compose up -d"
    return 0
  fi

  check_db_reachable
  start_services
  show_summary
}

# ---------------------------------------------------------------------------
# update and status
# ---------------------------------------------------------------------------

CURRENT=""        # TAGAVE_VERSION in .env before the update
FROM_VERSION=""   # the release running before the update: CURRENT, or what
                  # runs now when CURRENT floats (latest, edge); empty if unknown
TARGET=""         # the version the update moves to
UPDATE_BACKUP_DIR=""     # this update's copy of the configuration and database
NEW_APP_STARTED=0 # the new app has started, so it may have changed the database

# Same as compose, but keeps stdin (for feeding a dump to pg_restore).
compose_in() { (cd "$INSTALL_DIR" && docker compose "$@"); }

# Reads what an earlier install wrote to .env.
load_install() {
  local env_file="$INSTALL_DIR/.env"
  [ -f "$env_file" ] \
    || die "no tagave install in $INSTALL_DIR (it has no .env). Pass --dir with the folder you installed to."
  ROLE="$(env_get TAGAVE_ROLE "$env_file")"
  case "$ROLE" in all|app|files) ;; *) die "$env_file has no TAGAVE_ROLE; run the installer once to record it." ;; esac
  CURRENT="$(env_get TAGAVE_VERSION "$env_file")"
  local registry
  registry="$(env_get TAGAVE_REGISTRY "$env_file")"
  [ -z "$registry" ] || TAGAVE_REGISTRY="$registry"
  PORT="$(env_get TAGAVE_PORT "$env_file")"
  DB_HOST="$(env_get DB_HOST "$env_file")"
  [ -n "$APP_URL" ] || APP_URL="$(env_get TAGAVE_APP_URL "$env_file")"
  if [ "$ROLE" = "files" ] && [ -z "$APP_URL" ] && [ -n "$DB_HOST" ]; then
    APP_URL="http://$DB_HOST:3100"
  fi
  APP_URL="${APP_URL%/}"
}

check_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed."
  docker info >/dev/null 2>&1 \
    || die "Docker is installed but not reachable. Start Docker, or add your user to the docker group, then run this again."
}

# The worker services this computer runs, one per line.
local_workers() { compose config --services 2>/dev/null | grep '^worker-' || true; }

# Asks the running app, from inside its container, for its version and
# health. Sets P_VERSION P_STATUS P_DB P_MIG P_BUILDS ("-" when unknown);
# P_BUILDS is the Build Versions check: pass when the app and every live
# worker run the same build.
PROBE_JS='const get=(p)=>fetch("http://127.0.0.1:3000/api/v1/"+p).then((r)=>r.json()).catch(()=>({}));
Promise.all([get("version"),get("health")]).then(([v,h])=>{
  const b=(h.checks||[]).find((c)=>c.id==="versions");
  console.log([v.version||"-",h.status||"down",h.database||"-",h.migrations||"-",b?b.status:"-"].join(" "));
});'
probe_app() {
  local out
  out="$(compose exec -T app node -e "$PROBE_JS" 2>/dev/null | tail -n 1 || true)"
  [ -n "$out" ] || out="- down - - -"
  read -r P_VERSION P_STATUS P_DB P_MIG P_BUILDS <<<"$out"
}

# local_image_version SERVICE IMAGE: the release the local container of
# SERVICE (or, when there is none, the local IMAGE) was built as, from its
# LINER_VERSION. Prints nothing when unknown.
local_image_version() {
  local id ref out
  id="$(compose ps -q "$1" 2>/dev/null | head -n 1 || true)"
  ref="${id:-$2}"
  out="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$ref" 2>/dev/null \
    | sed -n 's/^LINER_VERSION=//p' | head -n 1 || true)"
  if is_release "$out"; then printf '%s' "$out"; fi
}

# installed_version TAG: the release this install runs now (the app's own
# answer, or the version its local image was built as), for when .env names
# the floating TAG. Prints nothing when it cannot tell.
installed_version() {
  local tag="$1" registry out=""
  [ -f "$INSTALL_DIR/.env" ] || return 0
  registry="$(env_get TAGAVE_REGISTRY "$INSTALL_DIR/.env")"
  registry="${registry:-$TAGAVE_REGISTRY}"
  if [ "$ROLE" = "files" ]; then
    out="$(local_image_version worker-files "$registry/tagave-worker:$tag")"
  else
    probe_app
    if is_release "$P_VERSION"; then
      out="$P_VERSION"
    else
      out="$(local_image_version app "$registry/tagave-app:$tag")"
    fi
  fi
  printf '%s' "$out"
}

# Sets FROM_VERSION: CURRENT when it is a release, otherwise the release that
# runs now (a roll back to "latest" would pull the newest release, not the old
# one). When that is unknown too, a roll back cannot name the version to go
# back to, so the update only goes ahead with --yes.
settle_from_version() {
  FROM_VERSION="$CURRENT"
  if is_release "$CURRENT"; then return 0; fi
  FROM_VERSION="$(installed_version "${CURRENT:-latest}")"
  if [ -n "$FROM_VERSION" ]; then
    say "  .env says '${CURRENT:-nothing}', which is not a fixed release; the version running here is $FROM_VERSION."
    return 0
  fi
  warn "Cannot tell which version runs here: .env says '${CURRENT:-nothing}', and neither the running app nor the local image names a release. The roll back printed afterwards could then not name the version to go back to."
  [ "$ASSUME_YES" = "1" ] \
    || die "start tagave (docker compose up -d) so the update can read its version and try again, or re-run with --yes to update anyway."
}

# The version the app computer reports over the network (music computer).
remote_app_version() {
  [ -n "$APP_URL" ] || return 0
  fetch_text "$APP_URL/api/v1/version" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1
}

# The Build Versions status the app computer reports (pass, warn, ...).
remote_builds_status() {
  [ -n "$APP_URL" ] || return 0
  fetch_text "$APP_URL/api/v1/health" | tr -d '\n' \
    | sed -n 's/.*"id": *"versions"[^}]*"status": *"\([a-z]*\)".*/\1/p' | head -n 1
}

confirm() {
  local answer=""
  [ "$ASSUME_YES" != "1" ] || return 0
  [ -n "$TTY" ] || die "there is no terminal to ask on. Re-run with --yes to go ahead."
  printf '%s [y/N]: ' "$1" >"$TTY"
  IFS= read -r answer <"$TTY" || answer=""
  case "$answer" in
    y|Y|yes|Yes|YES) return 0 ;;
  esac
  say "  Nothing changed."
  exit 0
}

# set_env_version FILE VERSION: rewrites TAGAVE_VERSION, keeping the file private.
set_env_version() {
  local file="$1" version="$2"
  [ -f "$file" ] || return 0
  if grep -q '^TAGAVE_VERSION=' "$file"; then
    sed "s/^TAGAVE_VERSION=.*/TAGAVE_VERSION=$version/" "$file" | write_private "$file" >/dev/null
  else
    { cat "$file"; printf 'TAGAVE_VERSION=%s\n' "$version"; } | write_private "$file" >/dev/null
  fi
}

# Copies the configuration this update is about to change, so a roll back can
# put it back as it was.
save_configuration() {
  local name file
  UPDATE_BACKUP_DIR="$INSTALL_DIR/backups/pre-update-${FROM_VERSION:-unknown}-$(date +%Y%m%d-%H%M%S)"
  ( umask 077; mkdir -p "$UPDATE_BACKUP_DIR" )
  chmod 700 "$INSTALL_DIR/backups" "$UPDATE_BACKUP_DIR"
  for name in .env "$WORKER_ENV_NAME" "$COMPOSE_MAIN" "$COMPOSE_DB"; do
    [ ! -f "$INSTALL_DIR/$name" ] || cp -p "$INSTALL_DIR/$name" "$UPDATE_BACKUP_DIR/$name"
  done
  # A saved .env that says "latest" would roll forward, not back: pin the
  # release that runs now in the copy.
  if [ -n "$FROM_VERSION" ] && [ "$FROM_VERSION" != "$CURRENT" ]; then
    for name in .env "$WORKER_ENV_NAME"; do
      file="$UPDATE_BACKUP_DIR/$name"
      [ -f "$file" ] || continue
      if grep -q '^TAGAVE_VERSION=' "$file"; then
        ( umask 077; sed "s/^TAGAVE_VERSION=.*/TAGAVE_VERSION=$FROM_VERSION/" "$file" >"$file.tmp" )
      else
        ( umask 077; { cat "$file"; printf 'TAGAVE_VERSION=%s\n' "$FROM_VERSION"; } >"$file.tmp" )
      fi
      chmod 600 "$file.tmp"
      mv "$file.tmp" "$file"
    done
    say "     the saved .env pins TAGAVE_VERSION=$FROM_VERSION (it said '${CURRENT:-nothing}')"
  fi
  ok "Configuration saved to $UPDATE_BACKUP_DIR"
}

# A pg_dump in custom format, taken by the database container itself (its
# pg_dump always matches the server), then read back with pg_restore --list.
backup_database() {
  local dump="$UPDATE_BACKUP_DIR/database.pgdump" entries size
  if [ "$(container_health postgres)" != "healthy" ]; then
    compose up -d postgres || die "could not start the database to back it up (see above). Nothing was changed."
    wait_for postgres healthy 90 || die "the database did not start, so it could not be backed up. Nothing was changed."
  fi
  say "  Backing up the database (this can take a while on a large library)..."
  # shellcheck disable=SC2016 # $POSTGRES_USER and $POSTGRES_DB expand inside the container
  if ! ( umask 077; compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$dump" ); then
    die "the database backup failed (see above). Nothing was changed."
  fi
  entries="$(compose_in exec -T postgres pg_restore --list <"$dump" 2>/dev/null | grep -vc '^;' || true)"
  [ "${entries:-0}" -gt 0 ] || die "the backup at $dump could not be read back. Nothing was changed."
  size="$(du -h "$dump" | awk '{print $1}')"
  ok "Database backed up to $dump ($size, $entries entries)"
}

# Prints, as commands to paste, how to go back to CURRENT.
print_rollback() {
  local rel workers
  [ -n "$UPDATE_BACKUP_DIR" ] || return 0
  rel="${UPDATE_BACKUP_DIR#"$INSTALL_DIR"/}"
  workers="$(local_workers | tr '\n' ' ')"
  say ""
  say "${C_BOLD}How to roll back to ${FROM_VERSION:-the previous version}${C_OFF}"
  say "  cd $INSTALL_DIR"
  if [ -z "$FROM_VERSION" ]; then
    say "  # the version from before the update is unknown: after copying .env back,"
    say "  # set TAGAVE_VERSION in it to that version (not latest) before 'docker compose pull'"
  fi
  if [ "$ROLE" = "files" ]; then
    say "  cp -p $rel/.env $rel/*.yml ."
    say "  docker compose pull && docker compose up -d"
    return 0
  fi
  if [ "$NEW_APP_STARTED" = "1" ]; then
    if [ "$ROLE" = "app" ]; then
      say "  # first, on the music computer: docker compose stop worker-files"
    fi
    say "  docker compose stop app ${workers% }"
    say "  cp -p $rel/.env $rel/*.yml ."
    [ ! -f "$UPDATE_BACKUP_DIR/$WORKER_ENV_NAME" ] || say "  cp -p $rel/$WORKER_ENV_NAME ."
    say "  # put the database back as it was before the update"
    # shellcheck disable=SC2016 # printed for the user to paste, not run here
    say '  docker compose exec -T postgres sh -c '\''dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'\'''
    # shellcheck disable=SC2016
    say '  docker compose exec -T postgres sh -c '\''pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'\'' < '"$rel/database.pgdump"
    say "  docker compose pull && docker compose up -d"
  else
    say "  # the new version never started, so the database is unchanged"
    say "  cp -p $rel/.env $rel/*.yml ."
    [ ! -f "$UPDATE_BACKUP_DIR/$WORKER_ENV_NAME" ] || say "  cp -p $rel/$WORKER_ENV_NAME ."
    say "  docker compose pull && docker compose up -d"
  fi
  if [ "$ROLE" = "app" ]; then
    say "  # then, on the music computer: install-tagave.sh update (it follows the app)"
  fi
  say "  More in docs/operations.md, section Roll back."
}

# Checks that both images exist under TARGET.
check_target_images() {
  if [ "${TAGAVE_SKIP_IMAGE_CHECK:-0}" = "1" ]; then return 0; fi
  image_exists "$TAGAVE_REGISTRY/tagave-worker:$TARGET" || explain_missing_image "$TAGAVE_REGISTRY/tagave-worker:$TARGET"
  if [ "$ROLE" != "files" ]; then
    image_exists "$TAGAVE_REGISTRY/tagave-app:$TARGET" || explain_missing_image "$TAGAVE_REGISTRY/tagave-app:$TARGET"
  fi
}

# Waits until the new app answers with TARGET, its database and migration
# checks pass, and (when every worker runs here) the workers report its build.
wait_for_update_health() {
  local limit="${TAGAVE_HEALTH_TIMEOUT:-300}" i=0
  say "  Waiting for tagave $TARGET to report healthy (old worker heartbeats clear within two minutes)..."
  while :; do
    probe_app
    if [ "$P_STATUS" = "ok" ] && [ "$P_DB" != "error" ] && [ "$P_MIG" = "ok" ] \
       && { ! is_release "$TARGET" || [ "$P_VERSION" = "$TARGET" ]; }; then
      # On a split install the file worker updates later, on its own computer.
      if [ "$ROLE" = "app" ] || [ "$P_BUILDS" = "pass" ]; then return 0; fi
    fi
    [ "$i" -lt "$limit" ] || break
    sleep 3
    i=$((i + 3))
  done
  warn "Last answer from the app: version $P_VERSION, health $P_STATUS, database $P_DB, migrations $P_MIG, worker builds $P_BUILDS"
  return 1
}

# TARGET already runs here; only .env may still float. Pins it, restarts nothing.
pin_in_place() {
  if [ "$CURRENT" = "$TARGET" ]; then
    ok "Already on $TARGET; nothing to do."
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "  $TARGET already runs here; the update would only pin TAGAVE_VERSION=$TARGET in .env."
    say "  Dry run: nothing changed."
    return 0
  fi
  set_env_version "$INSTALL_DIR/.env" "$TARGET"
  set_env_version "$INSTALL_DIR/$WORKER_ENV_NAME" "$TARGET"
  ok "$TARGET already runs here; pinned TAGAVE_VERSION=$TARGET in .env (it said '${CURRENT:-nothing}'), so a pull stays on it."
}

# How many file workers checked in over the last 90 seconds. Workers delete
# their heartbeat when they stop, so a fresh one serving the scan queues is a
# file worker that still runs. Prints nothing when the database cannot tell.
FILE_WORKER_SQL="select count(*) from worker_heartbeats where seen_at > now() - interval '90 seconds' and info->'queues' ? 'scan.root';"
live_file_workers() {
  # shellcheck disable=SC2016 # $POSTGRES_USER and $POSTGRES_DB expand inside the container
  printf '%s\n' "$FILE_WORKER_SQL" \
    | compose_in exec -T postgres sh -c 'psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null \
    | tr -dc '0-9' || true
}

# On a split install the file worker runs on the music computer, out of this
# script's reach. Left running, it would run old code against the changed
# database, and whatever it writes after the backup is lost on a roll back.
check_remote_file_worker() {
  local live answer
  [ "$(container_health postgres)" = "healthy" ] || return 0
  while :; do
    live="$(live_file_workers)"
    { [ -n "$live" ] && [ "$live" -gt 0 ]; } || return 0
    warn "The file worker on the music computer is still running. Stop it there first, so it does not write to the database while the update changes it: docker compose stop worker-files"
    if [ "$DRY_RUN" = "1" ] || [ "$ASSUME_YES" = "1" ] || [ -z "$TTY" ]; then return 0; fi
    printf 'Press Enter once it is stopped to check again, or type "go on" to update anyway: ' >"$TTY"
    IFS= read -r answer <"$TTY" || answer="go on"
    [ "$answer" != "go on" ] || return 0
  done
}

run_update() {
  say "${C_BOLD}tagave update${C_OFF}"
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
  load_install
  check_docker
  MANIFEST_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/tagave-manifest.XXXXXX")"
  trap 'rm -f "$MANIFEST_ERR_FILE"' EXIT

  if [ "$ROLE" = "files" ]; then
    update_files_computer
  else
    update_app_computer
  fi
}

update_app_computer() {
  local workers worker
  step "Checking versions"
  probe_app
  say "  This install:     ${CURRENT:-unknown} (TAGAVE_VERSION in .env)"
  say "  Running now:      $P_VERSION"
  TARGET="$(normalize_version "$VERSION")"
  if [ -z "$TARGET" ]; then
    TARGET="$(latest_release)"
    [ -n "$TARGET" ] || die "could not look up the newest release on GitHub. Pass the version yourself: install-tagave.sh update --version X.Y.Z (see https://github.com/$TAGAVE_REPO/releases)."
  fi
  check_tag "$TARGET"
  say "  Target:           $TARGET"
  settle_from_version

  if [ "$TARGET" = "$FROM_VERSION" ] && { ! is_release "$TARGET" || [ "$P_VERSION" = "$TARGET" ]; }; then
    pin_in_place
    return 0
  fi
  if is_release "$TARGET" && is_release "$FROM_VERSION" && version_lt "$TARGET" "$FROM_VERSION"; then
    die "$TARGET is older than $FROM_VERSION, which runs here. tagave's database changes only go forward, so going back means restoring the backup taken before the update: see docs/operations.md, section Roll back."
  fi
  check_target_images

  workers="$(local_workers)"
  step "Update ${FROM_VERSION:-unknown} -> $TARGET"
  if is_release "$TARGET"; then say "  Release notes: $(release_notes_url "$TARGET")"; fi
  if [ "$ROLE" = "app" ]; then
    say "  0. first, on the music computer: docker compose stop worker-files"
    say "     (an old file worker must not write to the database while it changes)"
  fi
  say "  1. back up the database and this configuration to $INSTALL_DIR/backups/"
  say "  2. set TAGAVE_VERSION=$TARGET in .env"
  say "  3. download the $TARGET images"
  say "  4. stop the workers, start the new app (it updates the database) and wait until it is healthy"
  say "  5. start the workers and wait until they run the same build"
  if [ "$ROLE" = "app" ]; then
    say "  Afterwards, run install-tagave.sh update on the music computer too."
  fi
  [ "$ROLE" != "app" ] || check_remote_file_worker
  if [ "$DRY_RUN" = "1" ]; then
    say ""
    say "  Dry run: nothing changed."
    return 0
  fi
  confirm "Update to $TARGET now?"

  step "Backing up"
  save_configuration
  backup_database
  ON_DIE=print_rollback

  step "Switching to $TARGET"
  VERSION="$TARGET"
  fetch_compose_files
  set_env_version "$INSTALL_DIR/.env" "$TARGET"
  set_env_version "$INSTALL_DIR/$WORKER_ENV_NAME" "$TARGET"
  ok "TAGAVE_VERSION=$TARGET"
  validate_compose
  compose pull || die "downloading the $TARGET images failed (see above)."

  step "Restarting"
  if [ -n "$workers" ]; then
    # shellcheck disable=SC2086 # one service name per word
    compose stop $workers || die "could not stop the workers (see above)."
  fi
  NEW_APP_STARTED=1
  compose up -d app || die "the new app did not start (see above)."
  say "  Waiting for the web app (it applies any database changes first)..."
  if wait_for app healthy 600; then
    ok "Web app is up"
  else
    compose logs --tail 40 app >&2 || true
    die "the web app did not become healthy on $TARGET. The log above says why."
  fi
  compose up -d || die "docker compose could not start the workers (see above)."
  for worker in $workers; do
    wait_for_worker "$worker"
  done
  wait_for_update_health || die "tagave $TARGET did not report healthy in time. Check: docker compose logs --tail 50"
  ok "tagave $TARGET is healthy"
  ON_DIE=""

  step "Done"
  say "  tagave now runs $TARGET. The backup from before the update is in $UPDATE_BACKUP_DIR."
  if [ "$ROLE" = "app" ]; then
    say "  Now run install-tagave.sh update on the music computer, so the file worker runs $TARGET too."
  fi
  print_rollback
}

update_files_computer() {
  local app_version builds i
  step "Checking versions"
  app_version="$(remote_app_version)"
  say "  This computer:    ${CURRENT:-unknown} (TAGAVE_VERSION in .env)"
  if [ -n "$app_version" ]; then
    say "  App computer:     $app_version ($APP_URL)"
  else
    say "  App computer:     not reachable at ${APP_URL:-an unknown address}"
  fi
  TARGET="$(normalize_version "$VERSION")"
  if [ -z "$app_version" ]; then
    [ -n "$TARGET" ] || die "could not ask the app computer for its version. Pass --app-url with the address you open tagave at (for example http://192.168.1.10:3100), or --version with the version it runs."
    warn "Could not check the app computer's version; using --version $TARGET as given."
  else
    TARGET="${TARGET:-$app_version}"
    if [ "$TARGET" != "$app_version" ]; then
      die "the app computer runs $app_version, and the file worker must run the same version. Update the app computer first (install-tagave.sh update there), then run this again without --version."
    fi
  fi
  check_tag "$TARGET"
  say "  Target:           $TARGET"
  settle_from_version
  if [ "$TARGET" = "$FROM_VERSION" ]; then
    pin_in_place
    return 0
  fi
  check_target_images

  step "Update ${FROM_VERSION:-unknown} -> $TARGET"
  say "  1. save this configuration to $INSTALL_DIR/backups/ (the database lives on the app computer)"
  say "  2. set TAGAVE_VERSION=$TARGET in .env"
  say "  3. download the $TARGET worker image and restart the file worker"
  if [ "$DRY_RUN" = "1" ]; then
    say ""
    say "  Dry run: nothing changed."
    return 0
  fi
  confirm "Update the file worker to $TARGET now?"

  save_configuration
  ON_DIE=print_rollback
  VERSION="$TARGET"
  fetch_compose_files
  set_env_version "$INSTALL_DIR/.env" "$TARGET"
  ok "TAGAVE_VERSION=$TARGET"
  validate_compose
  compose pull || die "downloading the $TARGET worker image failed (see above)."
  compose up -d || die "docker compose could not start the file worker (see above)."
  wait_for_worker worker-files
  if [ -n "$app_version" ]; then
    i=0
    say "  Waiting for the app computer to see the same build on every worker..."
    while :; do
      builds="$(remote_builds_status)"
      [ "$builds" != "pass" ] || break
      if [ "$i" -ge "${TAGAVE_HEALTH_TIMEOUT:-180}" ]; then
        warn "The app computer still reports workers on another build. Check Settings > Updates in the app."
        break
      fi
      sleep 3
      i=$((i + 3))
    done
    [ "$builds" != "pass" ] || ok "The app and every worker run the same build"
  fi
  ON_DIE=""
  step "Done"
  say "  The file worker now runs $TARGET."
  print_rollback
}

run_status() {
  local latest app_version builds have
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
  load_install
  check_docker
  say "${C_BOLD}tagave in $INSTALL_DIR${C_OFF}"
  say "  Role:             $ROLE"
  say "  Version (.env):   ${CURRENT:-unknown}"

  if [ "$ROLE" = "files" ]; then
    app_version="$(remote_app_version)"
    if [ -n "$app_version" ]; then
      say "  App computer:     $app_version ($APP_URL)"
      builds="$(remote_builds_status)"
      say "  Worker builds:    ${builds:-unknown} (pass means the app and every worker match)"
      if is_release "$app_version" && [ "$app_version" != "$CURRENT" ]; then
        warn "The app computer runs $app_version but this file worker is set to $CURRENT. Run: install-tagave.sh update"
      fi
    else
      say "  App computer:     not reachable at ${APP_URL:-an unknown address} (pass --app-url)"
    fi
  else
    probe_app
    say "  Running now:      $P_VERSION"
    say "  Health:           $P_STATUS (database $P_DB, migrations $P_MIG)"
    say "  Worker builds:    $P_BUILDS (pass means the app and every worker match)"
  fi
  # A floating .env (latest) is judged by the version that runs.
  have="$CURRENT"
  if ! is_release "$have" && [ "$ROLE" != "files" ] && is_release "$P_VERSION"; then have="$P_VERSION"; fi
  if ! is_release "$CURRENT" && [ -n "$CURRENT" ]; then
    warn ".env says TAGAVE_VERSION=$CURRENT, which moves with every pull. Pin it with: install-tagave.sh update"
  fi

  step "Containers"
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' || true

  step "Releases"
  latest="$(latest_release)"
  if [ -z "$latest" ]; then
    say "  Could not look up the newest release (https://github.com/$TAGAVE_REPO/releases)."
  elif is_release "$have" && version_lt "$have" "$latest"; then
    say "  tagave $latest is out: $(release_notes_url "$latest")"
    if [ "$ROLE" = "files" ]; then
      say "  Update the app computer first, then run here: install-tagave.sh update"
    else
      say "  To update: install-tagave.sh update"
    fi
  elif [ "$have" = "$latest" ]; then
    ok "Up to date ($latest is the newest release)"
  else
    say "  Newest release: $latest (this install runs ${have:-an unknown version})"
  fi
}

case "$COMMAND" in
  install) main ;;
  update)  run_update ;;
  status)  run_status ;;
esac

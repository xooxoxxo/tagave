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
ASSUME_YES="${TAGAVE_YES:-0}"
NO_START=0
PLATFORM=""
REPLACE_SECRETS=0
VERSION_FROM_ENV_FILE=0

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
die()     { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install-tagave.sh [options]

  --role all|app|files     what runs on this computer (default: all)
  --dir PATH               install directory (default: ~/tagave)
  --music PATH             your music folder on this computer (roles all, files)
  --port N                 web app port on this computer (default: 3100)
  --version TAG            image tag to run, e.g. 0.2.0 (default: latest release)
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

  --yes, -y                never ask; use flags, environment and defaults
  --no-start               write the configuration and check it, start nothing
  --help, -h               this text

Each option can also be set as an environment variable: TAGAVE_ROLE,
TAGAVE_DIR, TAGAVE_MUSIC_DIR, TAGAVE_PORT, TAGAVE_VERSION, TAGAVE_TZ,
TAGAVE_ADVERTISE_ADDRESS, TAGAVE_DB_HOST, TAGAVE_DB_PORT, TAGAVE_DB_BIND,
TAGAVE_FROM, TAGAVE_BEHIND_HTTPS=1, TAGAVE_YES=1. TAGAVE_REF picks the git
ref the compose files are downloaded from (default: the release being installed).
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

need_arg() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value (see --help)"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)              need_arg "$@"; ROLE="$2"; shift 2 ;;
    --dir)               need_arg "$@"; INSTALL_DIR="$2"; shift 2 ;;
    --music)             need_arg "$@"; MUSIC_DIR="$2"; shift 2 ;;
    --port)              need_arg "$@"; PORT="$2"; shift 2 ;;
    --version)           need_arg "$@"; VERSION="$2"; shift 2 ;;
    --timezone)          need_arg "$@"; TIMEZONE="$2"; shift 2 ;;
    --advertise-address) need_arg "$@"; ADVERTISE_ADDRESS="$2"; shift 2 ;;
    --db-host)           need_arg "$@"; DB_HOST="$2"; shift 2 ;;
    --db-port)           need_arg "$@"; DB_PORT="$2"; shift 2 ;;
    --db-bind)           need_arg "$@"; DB_BIND="$2"; shift 2 ;;
    --from)              need_arg "$@"; FROM_FILE="$2"; shift 2 ;;
    --behind-https)      BEHIND_HTTPS=1; shift ;;
    --replace-secrets)   REPLACE_SECRETS=1; shift ;;
    --yes|-y)            ASSUME_YES=1; shift ;;
    --no-start)          NO_START=1; shift ;;
    --help|-h)           usage; exit 0 ;;
    *)                   die "unknown option: $1 (see --help)" ;;
  esac
done

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
  local arg_db_host="$DB_HOST" arg_db_port="$DB_PORT" arg_version="$VERSION"

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
    [ -n "$ADVERTISE_ADDRESS" ] || ADVERTISE_ADDRESS="$(env_get TAGAVE_ADVERTISE_ADDRESS "$existing")"
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
  local tag=""

  # For tests (scripts/test-installer.sh): trust --version without asking the
  # registry, so the configuration can be checked offline.
  if [ "${TAGAVE_SKIP_IMAGE_CHECK:-0}" = "1" ]; then
    [ -n "$VERSION" ] || die "TAGAVE_SKIP_IMAGE_CHECK=1 needs --version"
    ok "Version $VERSION (not checked against the registry)"
    return 0
  fi
  # An install that recorded edge before any release existed moves to the
  # stable release once one is published; an explicit --version stays put.
  if [ "$VERSION" = "edge" ] && [ "$VERSION_FROM_ENV_FILE" = "1" ] && [ "$ROLE" != "files" ] \
     && image_exists "$TAGAVE_REGISTRY/tagave-app:latest"; then
    VERSION=""
    say "  A stable release is out now; moving this install from edge to it."
  fi

  if [ -n "$VERSION" ]; then
    tag="$VERSION"
  elif image_exists "$TAGAVE_REGISTRY/tagave-app:latest"; then
    tag="latest"
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
      if command -v curl >/dev/null 2>&1; then
        tag="$(curl -fsSL "https://api.github.com/repos/$TAGAVE_REPO/releases/latest" 2>/dev/null \
          | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1 || true)"
      fi
      printf '%s' "${tag:-main}"
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
    [ -n "$new_secret" ] && [ -n "$new_password" ] \
      || die "$FROM_FILE has no APP_SECRET or POSTGRES_PASSWORD; copy it again from the app computer"
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
    [ -n "$APP_SECRET" ] && [ -n "$POSTGRES_PASSWORD" ] \
      || die "a file worker needs the app computer's secrets: pass --from $WORKER_ENV_NAME"
    return 0
  fi

  # A database volume without a password on record means the password that
  # opens it is lost from this folder; a new one would not match it.
  if [ -z "$POSTGRES_PASSWORD" ] && docker volume inspect "${PROJECT_NAME}_pgdata" >/dev/null 2>&1; then
    die "a tagave database already exists (docker volume ${PROJECT_NAME}_pgdata) but $existing has no POSTGRES_PASSWORD. Restore the .env you installed with; the installer will not create a new password that cannot open that database."
  fi

  if [ -z "$APP_SECRET" ]; then
    APP_SECRET="$(generate_secret)" && [ -n "$APP_SECRET" ] || die "generating the app secret failed"
    ok "Generated a new app secret"
  else
    ok "Kept the app secret already in .env"
  fi
  if [ -z "$POSTGRES_PASSWORD" ]; then
    POSTGRES_PASSWORD="$(generate_password)" && [ -n "$POSTGRES_PASSWORD" ] || die "generating the database password failed"
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
  [ -n "$APP_SECRET" ] && [ -n "$POSTGRES_PASSWORD" ] \
    || die "refusing to write .env without an app secret and a database password"
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

# images: change TAGAVE_VERSION, then docker compose pull && docker compose up -d
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
    fi
    if [ "$ROLE" = "app" ]; then
      printf '\n# database published for the file worker on the music computer\nDB_BIND=%s\nDB_PORT=%s\nTAGAVE_ADVERTISE_ADDRESS=%s\n' \
        "$DB_BIND" "$DB_PORT" "$ADVERTISE_ADDRESS"
    fi
    if [ "$ROLE" = "files" ]; then
      printf '\n# database on the app computer\nDB_HOST=%s\nDB_PORT=%s\n' "$DB_HOST" "$DB_PORT"
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
  compose up -d || die "docker compose could not start tagave (see above)."

  if [ "$ROLE" != "files" ]; then
    say "  Waiting for the web app (the first start sets up the database)..."
    if wait_for app healthy 180; then
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
  say "    docker compose pull && docker compose up -d    update to the newest images"
  if [ "$ROLE" != "files" ]; then
    say "    docker compose exec app node packages/doctor/dist/cli.js doctor    full health check"
    say "    docker compose exec app node packages/doctor/dist/cli.js backup    back up the database"
  fi
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

main

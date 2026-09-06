#!/bin/bash
# Liner deploy: app container (api+web) and/or the worker host.
# Usage: scripts/deploy.sh [app|workers|all]   (default: all)
#
# Serialised: one deploy at a time per machine (local lock) AND per target
# (remote lock), so two sessions cannot interleave rsync/build/restart.
# Refuses a dirty working tree — a deploy ships exactly one commit, and the
# target records which one (DEPLOYED file) so the next deployer can tell.
#
# Targets come from .deploy.env (gitignored; see .deploy.env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
WHAT=${1:-all}
[ -f .deploy.env ] || { echo "missing .deploy.env (copy .deploy.env.example)"; exit 2; }
# shellcheck disable=SC1091
source .deploy.env
: "${APP_HOST:?}" "${APP_DIR:?}" "${WORKER_HOST:?}" "${WORKER_DIR:?}" "${WORKER_NODE_BIN:?}"

COMMIT=$(git rev-parse --short HEAD)
SRC_DIR=$(pwd)
if [ -n "$(git status --porcelain)" ]; then
  if [ "${DEPLOY_FROM_HEAD:-0}" = "1" ]; then
    # Two sessions share this checkout: ship exactly HEAD, never the other
    # session's work in progress. Export the commit and rsync from the export.
    SRC_DIR=$(mktemp -d /tmp/liner-deploy-src.XXXXXX)
    git archive HEAD | tar -x -C "$SRC_DIR"
    echo "working tree is dirty; DEPLOY_FROM_HEAD=1 → deploying commit $COMMIT from an export (uncommitted files ignored):"
    git status --short | sed 's/^/    ignored: /'
  else
    echo "working tree is dirty — commit first, or DEPLOY_FROM_HEAD=1 to ship exactly HEAD:"; git status --short; exit 3
  fi
fi
cd "$SRC_DIR"
EXPORT_DIR=""; case "$SRC_DIR" in /tmp/liner-deploy-src.*) EXPORT_DIR="$SRC_DIR" ;; esac

# Local lock (mkdir is atomic on APFS; macOS has no flock binary).
LOCK=/tmp/liner-deploy.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another deploy is running (lock $LOCK, owner: $(cat "$LOCK/owner" 2>/dev/null)); wait or remove a stale lock"; exit 4
fi
echo "$$ $(date +%FT%T) $USER" > "$LOCK/owner"
REMOTE_LOCKED_HOST=""
cleanup() {
  [ -n "$REMOTE_LOCKED_HOST" ] && ssh "$REMOTE_LOCKED_HOST" 'rm -rf /tmp/liner-deploy.lock' 2>/dev/null || true
  rm -rf "$LOCK"
  [ -n "${EXPORT_DIR:-}" ] && rm -rf "$EXPORT_DIR"
  return 0
}
trap cleanup EXIT

remote_lock() {  # $1 host
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$1" true 2>/dev/null \
    || { echo "ssh to $1 failed — key agent locked or host down; nothing deployed there"; exit 6; }
  ssh "$1" 'mkdir /tmp/liner-deploy.lock 2>/dev/null && echo "'"$COMMIT $(date +%FT%T)"'" > /tmp/liner-deploy.lock/owner' \
    || { echo "remote deploy lock held on $1: $(ssh "$1" cat /tmp/liner-deploy.lock/owner 2>/dev/null)"; exit 5; }
  REMOTE_LOCKED_HOST="$1"
}
remote_unlock() { ssh "$1" 'rm -rf /tmp/liner-deploy.lock' || true; REMOTE_LOCKED_HOST=""; }

EXCLUDES=(--exclude node_modules --exclude .git --exclude '*.tsbuildinfo' --exclude 'packages/*/dist' --exclude '.deploy.env')

deploy_app() {
  echo "== app → $APP_HOST ($COMMIT)"
  remote_lock "$APP_HOST"
  # never --delete and never touch the host's own env file
  rsync -az "${EXCLUDES[@]}" --exclude '.env' ./ "$APP_HOST:$APP_DIR/"
  ssh "$APP_HOST" "cd $APP_DIR && docker compose -f docker-compose.prod.yml build app 2>&1 | tail -3 && docker compose -f docker-compose.prod.yml up -d app && echo $COMMIT > DEPLOYED && sleep 6 && docker compose -f docker-compose.prod.yml logs --tail=20 app | grep -E 'applying|Database initialized|Server running|rror' || true"
  echo "== health"; curl -sf "$APP_HEALTH_URL" && echo
  remote_unlock "$APP_HOST"
}

deploy_workers() {
  echo "== workers → $WORKER_HOST ($COMMIT)"
  remote_lock "$WORKER_HOST"
  rsync -az "${EXCLUDES[@]}" --exclude dist packages/shared packages/core packages/db packages/worker packages/doctor "$WORKER_HOST:$WORKER_DIR/packages/"
  rsync -az package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml "$WORKER_HOST:$WORKER_DIR/"
  # every manifest must be present for the frozen lockfile to validate, even
  # for packages the worker host never builds (api, web); deps are installed
  # only for the worker-side packages to spare the host's disk
  for m in packages/*/package.json; do rsync -az "$m" "$WORKER_HOST:$WORKER_DIR/$m"; done
  ssh "$WORKER_HOST" "export PATH=$WORKER_NODE_BIN:\$PATH; cd $WORKER_DIR && pnpm install --frozen-lockfile --prefer-offline --filter @liner/shared --filter @liner/core --filter @liner/db --filter @liner/doctor --filter @liner/worker 2>&1 | tail -2"
  ssh "$WORKER_HOST" "export PATH=$WORKER_NODE_BIN:\$PATH; cd $WORKER_DIR && find packages -name '*.tsbuildinfo' -delete && pnpm --filter @liner/shared --filter @liner/core --filter @liner/db --filter @liner/doctor --filter @liner/worker build 2>&1 | tail -4 && echo $COMMIT > DEPLOYED"
  # migrations before the workers restart (the app applies them on boot too; this is idempotent)
  ssh "$WORKER_HOST" "export PATH=$WORKER_NODE_BIN:\$PATH; cd $WORKER_DIR && DATABASE_URL='$WORKER_DATABASE_URL' node -e \"import('$WORKER_DIR/packages/db/dist/migrations-lib.js').then(m=>m.runMigrations(process.env.DATABASE_URL))\" 2>&1 | grep -E 'applying|rror' || true"
  ssh "$WORKER_HOST" "$WORKER_RESTART_CMD"
}

case "$WHAT" in
  app) deploy_app ;;
  workers) deploy_workers ;;
  all) deploy_app; deploy_workers ;;
  *) echo "usage: $0 [app|workers|all]"; exit 2 ;;
esac
echo "== deployed $COMMIT ($WHAT)"

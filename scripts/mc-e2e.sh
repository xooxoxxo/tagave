#!/usr/bin/env bash
# mc-e2e.sh - Music Connections end to end: tagave and review-gatherer in one
# throwaway compose project, linked both ways (e2e/mc/mc.e2e.mjs says what it
# checks). Manual, not a CI gate: review-gatherer is not part of this repo, so
# you build its image yourself and name it here.
#
#   MC_E2E_RG_IMAGE     required: the review-gatherer API image (unset: skip)
#   MC_E2E_RG_SEED      required: SQL run in its database once it has started
#                       (its schema beyond what it migrates on boot, and the
#                       albums in FIXTURE of e2e/mc/mc.e2e.mjs)
#   MC_E2E_RG_ENV_FILE  optional: env file for its container (secret, flags)
#   MC_E2E_TAG          optional: tag of the tagave images to use or build
#                       (default: the current commit); kept when they existed
#   MC_E2E_KEEP=1       leave the stack up after the run (remove it with the
#                       `down` command it prints)
#
# Everything it creates is named mce2e-*: the compose project mce2e-<random>
# (containers, one internal network, no named volumes) and, unless they
# existed, the images mce2e-tg-app:<tag> and mce2e-tg-worker:<tag>.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${MC_E2E_RG_IMAGE:-}" ]; then
  echo "mc-e2e: skipped. Set MC_E2E_RG_IMAGE to a review-gatherer API image and MC_E2E_RG_SEED to its seed SQL (docs/operations.md, Music Connections end to end)."
  exit 0
fi
if [ -z "${MC_E2E_RG_SEED:-}" ] || [ ! -r "$MC_E2E_RG_SEED" ]; then
  echo "mc-e2e: MC_E2E_RG_SEED must name a readable SQL file" >&2
  exit 2
fi
if [ -n "${MC_E2E_RG_ENV_FILE:-}" ] && [ ! -r "$MC_E2E_RG_ENV_FILE" ]; then
  echo "mc-e2e: MC_E2E_RG_ENV_FILE is not readable" >&2
  exit 2
fi
if ! docker image inspect "$MC_E2E_RG_IMAGE" >/dev/null 2>&1; then
  echo "mc-e2e: no local image $MC_E2E_RG_IMAGE (build it first)" >&2
  exit 2
fi

MC_E2E_PROJECT="mce2e-$(openssl rand -hex 4)"
MC_E2E_TAG="${MC_E2E_TAG:-$(git rev-parse --short HEAD)}"
MC_E2E_APP_SECRET="$(openssl rand -hex 32)"
MC_E2E_RG_ENV_FILE="${MC_E2E_RG_ENV_FILE:+$(cd "$(dirname "$MC_E2E_RG_ENV_FILE")" && pwd)/$(basename "$MC_E2E_RG_ENV_FILE")}"
export MC_E2E_PROJECT MC_E2E_TAG MC_E2E_APP_SECRET MC_E2E_RG_IMAGE MC_E2E_RG_ENV_FILE

compose() { docker compose -f e2e/mc/compose.yml "$@"; }

built=()
for img in tg-app tg-worker; do
  docker image inspect "mce2e-$img:$MC_E2E_TAG" >/dev/null 2>&1 || built+=("mce2e-$img:$MC_E2E_TAG")
done

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "mc-e2e: failed; the last log lines of each app:" >&2
    compose logs --no-color --tail 60 tg-app tg-worker rg >&2 || true
  fi
  if [ "${MC_E2E_KEEP:-}" = "1" ]; then
    echo "mc-e2e: kept. Remove it with:"
    echo "  MC_E2E_PROJECT=$MC_E2E_PROJECT MC_E2E_NET=$MC_E2E_NET MC_E2E_TAG=$MC_E2E_TAG MC_E2E_APP_SECRET=x MC_E2E_RG_IMAGE=$MC_E2E_RG_IMAGE docker compose -f e2e/mc/compose.yml --profile runner down -v --remove-orphans"
    exit "$status"
  fi
  compose --profile runner down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "${#built[@]}" -gt 0 ]; then docker image rm "${built[@]}" >/dev/null 2>&1 || true; fi
  exit "$status"
}

# A private /24 that no other Docker network uses. This only catches an
# exact /24 or a whole /16; any other overlap makes compose fail loudly at
# `up`, which is accepted.
taken="$(docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
MC_E2E_NET=""
for _ in 1 2 3 4 5 6 7 8; do
  a=$((28 + RANDOM % 4))
  b=$((RANDOM % 256))
  case " $taken " in
    *" 172.$a.$b.0/"* | *" 172.$a.0.0/16 "*) ;;
    *) MC_E2E_NET="172.$a.$b"; break ;;
  esac
done
if [ -z "$MC_E2E_NET" ]; then
  echo "mc-e2e: no free subnet found" >&2
  exit 2
fi
export MC_E2E_NET
trap cleanup EXIT
# A killed run (Ctrl-C, kill) still goes through cleanup: logs, then teardown.
trap 'exit 130' INT
trap 'exit 143' TERM

echo "mc-e2e: project $MC_E2E_PROJECT on $MC_E2E_NET.0/24"
if [ "${#built[@]}" -gt 0 ]; then
  echo "mc-e2e: building ${built[*]}"
  compose build tg-app tg-worker
fi

compose up -d --wait tg-db rg-db tg-app
compose exec -T tg-db psql -q -U e2e -d e2e < e2e/mc/tagave-seed.sql
compose up -d rg tg-worker

# The other app migrates on boot; its seed goes in once it answers.
compose run --rm runner wait
compose exec -T rg-db psql -q -v ON_ERROR_STOP=1 -U e2e -d e2e < "$MC_E2E_RG_SEED"

compose run --rm runner run

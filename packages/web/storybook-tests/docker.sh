#!/bin/sh
# Runs the story tests in the official Playwright image (linux/amd64), the
# image the CI job runs in, so screenshots match the committed baselines.
#
#   pnpm build-storybook && pnpm test-storybook:docker [--update-snapshots]
#
# The work happens in packages/web/.storybook-docker (git-ignored, on the
# host disk, not in the container): the built Storybook and the tests are
# copied there and the two test packages installed at the versions pinned in
# package.json; the baselines (and the results on failure) are copied back.
# The package's own node_modules are never used: they hold macOS binaries.
set -eu
WEB="$(cd "$(dirname "$0")/.." && pwd)"
PW="$(node -p "require('$WEB/package.json').devDependencies['@playwright/test']")"
AXE="$(node -p "require('$WEB/package.json').devDependencies['@axe-core/playwright']")"
[ -d "$WEB/storybook-static" ] || { echo "build Storybook first: pnpm build-storybook" >&2; exit 1; }
# PLATFORM=linux/arm64 runs natively on Apple silicon; its screenshots can
# differ from the amd64 CI runners by a few anti-aliased pixels.
exec docker run --rm --platform "${PLATFORM:-linux/amd64}" --ipc=host \
  -e CI=1 -e STORYBOOK_VISUAL=1 \
  -v "$WEB":/web \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  sh -c '
    set -e
    mkdir -p /web/.storybook-docker && cd /web/.storybook-docker
    rm -rf storybook-static storybook-tests storybook-test-results
    cp -r /web/storybook-static /web/storybook-tests .
    [ -f package.json ] || echo "{\"private\": true}" > package.json
    npm install --no-audit --no-fund --silent "@playwright/test@'"$PW"'" "@axe-core/playwright@'"$AXE"'"
    status=0
    npx playwright test -c storybook-tests/playwright.config.ts "$@" || status=$?
    rm -rf /web/storybook-tests/__screenshots__ && cp -r storybook-tests/__screenshots__ /web/storybook-tests/ 2>/dev/null || true
    [ -d storybook-test-results ] && rm -rf /web/storybook-test-results && cp -r storybook-test-results /web/ || true
    exit $status
  ' sh "$@"

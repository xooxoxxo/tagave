#!/usr/bin/env bash
# Refuse to publish when the git tag disagrees with the manifest version.
# Settings > Updates compares these numbers, so a mismatch ships a release that
# the update check reads wrongly, with nothing failing loudly.
#
# usage: check-version-tag.sh <tag> [package.json path]
set -euo pipefail

TAG="${1:-}"
MANIFEST="${2:-package.json}"

if [ -z "$TAG" ]; then
  echo "check-version-tag: no tag given" >&2
  exit 1
fi

VERSION="$(node -p "require('./${MANIFEST#./}').version" 2>/dev/null || node -p "require('$MANIFEST').version")"
WANT="${TAG#v}"

if [ "$WANT" != "$VERSION" ]; then
  echo "check-version-tag: tag '$TAG' does not match $MANIFEST version '$VERSION'" >&2
  echo "  bump the version and re-tag, or tag v$VERSION" >&2
  exit 1
fi

echo "check-version-tag: tag '$TAG' matches $MANIFEST version '$VERSION'"

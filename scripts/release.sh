#!/usr/bin/env bash
# Cut a release: version bump, release notes, CHANGELOG.md, commit, annotated tag.
#
# usage: scripts/release.sh X.Y.Z
#
# Run it twice. The first run writes a draft of release-notes/vX.Y.Z.md from
# the commits since the last release and stops; edit the draft (summary line,
# merge bullets into topics, plain words, remove the draft marker and every
# TODO:). The second run checks the notes, rebuilds CHANGELOG.md, commits
# "chore: X.Y.Z" and tags vX.Y.Z. Nothing is pushed: it prints the commands.
#
# Refuses a non-main branch, a tree with changes other than its own files, an
# existing tag, and a version that bumps less than the commits need
# (scripts/release-notes.mjs).
set -euo pipefail

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: scripts/release.sh X.Y.Z" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TAG="v${VERSION}"
NOTES="release-notes/${TAG}.md"
OWN_FILES=("package.json" "$NOTES" "CHANGELOG.md")

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "release: on branch '$branch'; releases are cut from main" >&2
  exit 1
fi

# Changes to tracked files other than the ones this script writes.
dirty="$(git status --porcelain --untracked-files=no -- . \
  ":(exclude)package.json" ":(exclude)CHANGELOG.md" ":(exclude)$NOTES")"
if [ -n "$dirty" ]; then
  echo "release: the working tree has uncommitted changes:" >&2
  echo "$dirty" >&2
  echo "  commit or remove them first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "release: tag ${TAG} already exists" >&2
  exit 1
fi

# Checks the version against the commits (exits non-zero on an under-bump)
# and, when the notes are missing, is the draft.
draft="$(mktemp)"
trap 'rm -f "$draft"' EXIT
node scripts/release-notes.mjs --version "$VERSION" --to HEAD --out "$draft"

# Root package.json version, formatting kept.
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("fs");
  const text = fs.readFileSync("package.json", "utf8");
  const re = /("version"\s*:\s*")[^"]*(")/;
  if (!re.test(text)) {
    console.error("release: no version field in package.json");
    process.exit(1);
  }
  fs.writeFileSync("package.json", text.replace(re, (_, a, b) => a + process.argv[1] + b));
' "$VERSION"

if [ ! -f "$NOTES" ]; then
  mkdir -p release-notes
  cp "$draft" "$NOTES"
  echo "release: wrote the draft ${NOTES} and set package.json to ${VERSION}."
  echo "  Edit it to the standard of release-notes/v0.9.0.md: the one-sentence summary,"
  echo "  one bullet per topic in plain words, every bullet linking its commits."
  echo "  Remove the draft marker and every TODO:, then run scripts/release.sh ${VERSION} again."
  exit 0
fi

node scripts/release-notes.mjs --check "$NOTES"
node scripts/release-notes.mjs --changelog --out CHANGELOG.md

git add -- "${OWN_FILES[@]}"
git commit -m "chore: ${VERSION}"
git tag -a "$TAG" -m "$TAG"

echo
echo "release: committed chore: ${VERSION} and tagged ${TAG}. Nothing was pushed. To publish:"
echo "  git push origin main"
echo "  git push origin ${TAG}"

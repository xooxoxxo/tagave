#!/usr/bin/env bash
# Test for sync-music-connections.sh. No framework: a throwaway source repo
# with two tags, a throwaway target, and a handful of assertions.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/sync-music-connections.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SRC="$TMP/src"
mkdir -p "$SRC/src" "$SRC/test"
git -C "$SRC" init --quiet
git -C "$SRC" config user.email test@example.invalid
git -C "$SRC" config user.name test
for f in tsconfig.json tsconfig.test.json vitest.config.ts README.md CHANGELOG.md LICENSE; do echo "$f" > "$SRC/$f"; done
echo 'export const x = 1;' > "$SRC/src/index.ts"
echo 'test' > "$SRC/test/a.test.ts"
printf '{ "name": "music-connections", "version": "0.2.0" }\n' > "$SRC/package.json"
git -C "$SRC" add -A && git -C "$SRC" commit --quiet -m one && git -C "$SRC" tag v0.2.0
printf '{ "name": "music-connections", "version": "0.3.0" }\n' > "$SRC/package.json"
git -C "$SRC" commit --quiet -am two && git -C "$SRC" tag v9.9.9

DEST="$TMP/dest"; mkdir -p "$DEST"; echo x > "$DEST/VENDORED.md"
mkdir -p "$DEST/node_modules/zod" "$DEST/src"
echo 'stale' > "$DEST/src/stale.ts"
echo 'hand edit' > "$DEST/HAND.md"

fail=0
check() { # description, condition...
  local desc="$1"; shift
  if "$@"; then echo "ok   - $desc"; else echo "FAIL - $desc"; fail=1; fi
}
run() { MC_VENDOR_DIR="$DEST" "$SUT" "$@" >/dev/null 2>&1; }

check "refuses no arguments"                 test "$(run; echo $?)" -ne 0
check "refuses an unknown tag"               test "$(run "$SRC" v1.0.0; echo $?)" -ne 0
check "refuses a tag that disagrees with package.json" test "$(run "$SRC" v9.9.9; echo $?)" -ne 0
check "syncs a matching tag"                 test "$(run "$SRC" v0.2.0; echo $?)" -eq 0
check "copies the source"                    test -f "$DEST/src/index.ts"
check "drops files the tag does not have"    test ! -e "$DEST/src/stale.ts"
check "drops hand-made files"                test ! -e "$DEST/HAND.md"
check "keeps node_modules"                   test -d "$DEST/node_modules/zod"
check "writes the tag into VENDORED.md"      grep -q '^- Tag: v0.2.0$' "$DEST/VENDORED.md"
check "never writes a local path"            test "$(grep -cF -- "$TMP" "$DEST/VENDORED.md")" -eq 0
check "syncs from a URL and names it"        test "$(run "file://$SRC" v0.2.0; echo $?)" -eq 0
check "the URL is the named source"          grep -qF -- "- Source: file://$SRC" "$DEST/VENDORED.md"

check "writes a content hash"                grep -Eq '^- Content: sha256:[0-9a-f]{64}$' "$DEST/VENDORED.md"
H1="$(grep '^- Content:' "$DEST/VENDORED.md")"
run "$SRC" v0.2.0
check "the content hash is reproducible"     test "$(grep '^- Content:' "$DEST/VENDORED.md")" = "$H1"
echo 'changed' >> "$DEST/src/index.ts"; run "$SRC" v0.2.0
check "a restored tree has the same hash"    test "$(grep '^- Content:' "$DEST/VENDORED.md")" = "$H1"

exit "$fail"

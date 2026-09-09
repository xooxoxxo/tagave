#!/usr/bin/env bash
# Test for check-version-tag.sh. No framework: a temp manifest and four assertions.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/check-version-tag.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '{\n  "name": "x",\n  "version": "0.2.0"\n}\n' > "$TMP/package.json"

fail=0
assert() { # description, expected_exit, args...
  local desc="$1" want="$2"; shift 2
  "$SUT" "$@" "$TMP/package.json" >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   - $desc"; else echo "FAIL - $desc (exit $got, wanted $want)"; fail=1; fi
}

assert "accepts a matching tag with a v prefix"    0 "v0.2.0"
assert "accepts a matching tag without the prefix" 0 "0.2.0"
assert "rejects a mismatched tag"                  1 "v0.3.0"
assert "rejects an empty tag"                      1 ""

exit "$fail"

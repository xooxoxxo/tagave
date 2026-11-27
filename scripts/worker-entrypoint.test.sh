#!/usr/bin/env bash
# Test for docker/worker-entrypoint.sh. No framework: each case gets a fresh
# fake root (TAGAVE_ENTRYPOINT_ROOT) with its own mount table, and the
# command the entrypoint runs is `echo ran`, so the output shows exec happened.
# The script runs under dash when it is installed (the image's /bin/sh).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/../docker/worker-entrypoint.sh"
SH="$(command -v dash || echo sh)"

fail=0
if ! shellcheck "$SUT"; then echo "FAIL - shellcheck"; fail=1; else echo "ok   - shellcheck"; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/offlinetest.XXXXXX")" || exit 1
trap 'rm -r "$TMP"' EXIT

# Makes a fake root with /mnt/.host and a mount table; prints its path.
# Extra arguments are mount points added to the table.
root() {
  local r mp
  r="$(mktemp -d "$TMP/root.XXXXXX")"
  mkdir -p "$r/mnt/.host" "$r/proc/self"
  {
    echo '21 1 0:20 / / rw,relatime - overlay overlay rw'
    echo '22 21 0:21 /mnt /mnt/.host rw,relatime shared:1 - ext4 /dev/sda1 rw'
    for mp in "$@"; do echo "23 21 0:22 / $mp ro,relatime - nfs4 192.0.2.10:/music rw"; done
  } >"$r/proc/self/mountinfo"
  echo "$r"
}
# root, name (or "-" for unset): runs the entrypoint, keeps stdout, stderr, exit.
run() {
  local r="$1" name="$2"
  if [ "$name" = "-" ]; then
    env -u TAGAVE_MUSIC_NAME TAGAVE_ENTRYPOINT_ROOT="$r" "$SH" "$SUT" echo ran >"$r/out" 2>"$r/err"
  else
    TAGAVE_ENTRYPOINT_ROOT="$r" TAGAVE_MUSIC_NAME="$name" "$SH" "$SUT" echo ran >"$r/out" 2>"$r/err"
  fi
  echo $? >"$r/code"
}
check() { # description, condition...
  local desc="$1"; shift
  if "$@"; then echo "ok   - $desc"; else echo "FAIL - $desc"; fail=1; fi
}
# shellcheck disable=SC2329 # ran and linked are called through check
ran() { [ "$(cat "$1/out")" = ran ] && [ "$(cat "$1/code")" = 0 ]; }
# shellcheck disable=SC2329
linked() { [ -L "$1/mnt/music" ] && [ "$(readlink "$1/mnt/music")" = "/mnt/.host/$2" ]; }

r="$(root)"; run "$r" -
check "no name: runs the command"                   ran "$r"
check "no name: /mnt/music is left alone"           test ! -e "$r/mnt/music" -a ! -L "$r/mnt/music"

r="$(root)"; run "$r" ""
check "an empty name: runs the command"             ran "$r"
check "an empty name: /mnt/music is left alone"     test ! -e "$r/mnt/music" -a ! -L "$r/mnt/music"

r="$(root)"; run "$r" music
check "a name: runs the command"                    ran "$r"
check "a name: /mnt/music links to /mnt/.host/music" linked "$r" music
check "a name: nothing is made under /mnt/.host"    test -z "$(ls -A "$r/mnt/.host")"

r="$(root)"; run "$r" "My Music-2.0_x"
check "a name with spaces and dots links"           linked "$r" "My Music-2.0_x"

r="$(root)"; ln -s /mnt/.host/old "$r/mnt/music"; run "$r" music
check "an existing link: runs the command"          ran "$r"
check "an existing link is replaced"                linked "$r" music

r="$(root)"; mkdir "$r/mnt/music"; run "$r" music
check "an empty folder: runs the command"           ran "$r"
check "an empty folder is replaced by the link"     linked "$r" music

r="$(root)"; mkdir "$r/mnt/music"; echo keep >"$r/mnt/music/keep.txt"; run "$r" music
check "a folder with files: runs the command"       ran "$r"
check "a folder with files is left alone"           test ! -L "$r/mnt/music" -a -f "$r/mnt/music/keep.txt"
check "a folder with files: one line says so"       test "$(wc -l <"$r/err")" -eq 1

for bad in "../x" "." ".." "a/b" "x
y"; do
  r="$(root)"; run "$r" "$bad"; shown="${bad//$'\n'/\\n}"
  check "refuses '$shown' with exit 64"             test "$(cat "$r/code")" = 64
  check "refuses '$shown' with the message"         grep -qx "TAGAVE_MUSIC_NAME is not a folder name" "$r/err"
  check "refuses '$shown' without running"          test ! -s "$r/out"
  check "refuses '$shown' and makes no link"        test ! -L "$r/mnt/music"
done

r="$(root /mnt/music)"; mkdir "$r/mnt/music"; echo keep >"$r/mnt/music/song.flac"; run "$r" music
check "a mount point: runs the command"             ran "$r"
check "a mount point is never replaced"             test ! -L "$r/mnt/music" -a -f "$r/mnt/music/song.flac"

r="$(root /mnt/music)"; mkdir "$r/mnt/music"; run "$r" music
check "an empty mount point is never replaced"      test ! -L "$r/mnt/music" -a -d "$r/mnt/music"

r="$(root '/mnt/music\040old')"; run "$r" music
check "a mount point with a longer name is not /mnt/music" linked "$r" music

# \143 is "c": the table's escapes are decoded before the match.
r="$(root '/mnt/musi\143')"; mkdir "$r/mnt/music"; run "$r" music
check "an escaped /mnt/music is a mount point"      test ! -L "$r/mnt/music" -a -d "$r/mnt/music"

r="$(root)"; echo file >"$r/mnt/music"; run "$r" music
check "a file: runs the command"                    ran "$r"
check "a file is left alone"                        test ! -L "$r/mnt/music" -a -f "$r/mnt/music"

r="$(root)"; rm "$r/proc/self/mountinfo"; mkdir "$r/mnt/music"; run "$r" music
check "no mount table: runs the command"            ran "$r"
check "no mount table: /mnt/music is left alone"    test ! -L "$r/mnt/music" -a -d "$r/mnt/music"

# An awk that fails (exit 2, as on a read error) is not "not a mount point":
# a shim earlier on PATH stands in for it.
r="$(root)"; mkdir "$r/mnt/music" "$r/bin"; printf '#!/bin/sh\nexit 2\n' >"$r/bin/awk"; chmod +x "$r/bin/awk"
PATH="$r/bin:$PATH" run "$r" music
check "a failed table read: runs the command"       ran "$r"
check "a failed table read: /mnt/music is left alone" test ! -L "$r/mnt/music" -a -d "$r/mnt/music"
check "a failed table read: one line says so"       grep -qx "tagave: the mount table cannot be read, so /mnt/music is left as it is" "$r/err"

exit "$fail"

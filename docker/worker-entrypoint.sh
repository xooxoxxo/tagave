#!/bin/sh
# The worker image's entrypoint. It runs before node and then hands over with
# exec "$@", so a compose `command:` still runs as given.
#
# Why the link: in the parent layout compose binds the folder that holds the
# music share at /mnt/.host (so container create never touches the share), and
# the share itself is /mnt/.host/$TAGAVE_MUSIC_NAME. Scan roots were saved as
# /mnt/music or folders under it, so this script makes /mnt/music a link to
# /mnt/.host/$TAGAVE_MUSIC_NAME and every saved path keeps working.
#
# - TAGAVE_MUSIC_NAME empty or unset (the direct layout, and worker-identify):
#   /mnt/music is the share's own bind, so nothing is touched.
# - A name that is not one folder name (only letters, digits, dot, underscore,
#   space and dash; not . or ..) stops the worker with exit 64.
# - /mnt/music listed as a mount point in /proc/self/mountinfo: left alone.
#   This is read before anything looks at /mnt/music, because a test on a dead
#   share's mount point can hang.
# - Otherwise /mnt/music is on the container's own filesystem: absent or a
#   link, it becomes the link; an empty folder is removed and becomes the link;
#   a folder with files in it (or a file) is left alone with one line on
#   stderr, and the worker still starts.
# Nothing under /mnt/.host is made, listed or checked: that is the share.
#
# TAGAVE_ENTRYPOINT_ROOT (tests only, default empty) is put in front of every
# path this script reads or changes: /mnt/music and /proc/self/mountinfo. The
# link it writes always points at the in-container path /mnt/.host/<name>,
# without the prefix, and the mount table is matched on /mnt/music as written.

root="${TAGAVE_ENTRYPOINT_ROOT:-}"
name="${TAGAVE_MUSIC_NAME:-}"

[ -n "$name" ] || exec "$@"

case "$name" in
  . | .. | *[!A-Za-z0-9._' '-]*)
    echo "TAGAVE_MUSIC_NAME is not a folder name" >&2
    exit 64
    ;;
esac

music="$root/mnt/music"
table="$root/proc/self/mountinfo"

if [ ! -r "$table" ]; then
  echo "tagave: the mount table cannot be read, so /mnt/music is left as it is" >&2
  exec "$@"
fi

# The mount point is the 5th field; mountinfo writes space, tab, newline and
# backslash in it as \ooo, so it is decoded before the match.
if awk '
  function decode(s,   out, i, c) {
    out = ""
    while ((i = index(s, "\\")) > 0) {
      c = substr(s, i + 1, 3)
      if (c ~ /^[0-7][0-7][0-7]$/) {
        out = out substr(s, 1, i - 1) sprintf("%c", substr(c, 1, 1) * 64 + substr(c, 2, 1) * 8 + substr(c, 3, 1))
        s = substr(s, i + 4)
      } else {
        out = out substr(s, 1, i)
        s = substr(s, i + 1)
      }
    }
    return out s
  }
  decode($5) == "/mnt/music" { found = 1 }
  END { exit !found }
' "$table"; then
  exec "$@"
fi

# Not a mount point, so these tests touch only the container's own files.
# -L comes first: -d on a link would follow it into the share.
if [ -L "$music" ] || [ ! -e "$music" ]; then
  :
elif [ -d "$music" ] && rmdir "$music" 2>/dev/null; then
  :
else
  echo "tagave: /mnt/music is not an empty folder, so it is left as it is and not linked to the music share" >&2
  exec "$@"
fi

ln -sfn "/mnt/.host/$name" "$music" \
  || echo "tagave: /mnt/music could not be linked to the music share" >&2

exec "$@"

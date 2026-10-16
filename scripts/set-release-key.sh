#!/usr/bin/env bash
# Puts the public half of a release signing key where releases are checked:
# deploy/release-keys/tagave-release.pem (copied into the updater and app
# images) and RELEASE_PUBLIC_KEY in install-tagave.sh. The private key stays
# where it is; only the public key is written.
#
#   openssl genpkey -algorithm ed25519 -out ~/tagave-release.key   # once, keep it safe
#   scripts/set-release-key.sh ~/tagave-release.key
#
# Then add the private key as the secret TAGAVE_RELEASE_SIGNING_KEY of the
# repository's "release" environment (docs/security.md, "Signed releases").
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
key="${1:?usage: scripts/set-release-key.sh PRIVATE_KEY_FILE}"
pem="$(openssl pkey -in "$key" -pubout)"
case "$pem" in *"BEGIN PUBLIC KEY"*) ;; *) echo "not a private key openssl can read: $key" >&2; exit 1 ;; esac
openssl pkey -in "$key" -noout -text 2>/dev/null | grep -q 'ED25519' || { echo "$key is not an Ed25519 key" >&2; exit 1; }
printf '%s\n' "$pem" >"$repo/deploy/release-keys/tagave-release.pem"
PEM="$pem" python3 - "$repo/install-tagave.sh" <<'PY'
import os, re, sys
path = sys.argv[1]
text = open(path).read()
new, n = re.subn(r"^RELEASE_PUBLIC_KEY='[^']*'$", "RELEASE_PUBLIC_KEY='" + os.environ["PEM"] + "'", text, count=1, flags=re.M)
if n != 1:
    sys.exit("RELEASE_PUBLIC_KEY= not found in install-tagave.sh")
open(path, "w").write(new)
PY
id="$(openssl pkey -in "$key" -pubout -outform DER | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)"
echo "deploy/release-keys/tagave-release.pem and install-tagave.sh now carry key $id"

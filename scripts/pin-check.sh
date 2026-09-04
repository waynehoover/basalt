#!/usr/bin/env bash
#
# Fails when compose.yaml, or a runbook, names a server image older than the
# newest server release.
#
# One implementation, called by .github/workflows/ci.yml and by
# scripts/check.sh, because the point of a check is undermined by having two
# copies of it that can disagree.
#
# Compared against the newest `server/v*` tag and not the plugin's manifest:
# the image is built on a server tag, so a client-only release correctly ships
# no image, and comparing against the manifest would fail every one of those
# for no reason.
#
# Older fails. Equal or newer passes, because the version bump commit lands
# before the tag that releases it.
set -euo pipefail

cd "$(dirname "$0")/.."
image=ghcr.io/waynehoover/basalt-sync

pinned=$(sed -n "s|.*image: $image:\([0-9][^@]*\)@sha256:.*|\1|p" compose.yaml)
if [ -z "$pinned" ]; then
  echo "could not read a tag@digest pin out of compose.yaml" >&2
  exit 1
fi

newest=$(git tag --list 'server/v*' | sed 's|server/v||' | sort -V | tail -1)
if [ -z "$newest" ]; then
  echo "no server/v* tag in the repository, nothing to compare against"
  exit 0
fi

echo "compose pins $pinned, newest server release is $newest"
older=$(printf '%s\n%s\n' "$pinned" "$newest" | sort -V | head -1)
if [ "$pinned" != "$newest" ] && [ "$older" = "$pinned" ]; then
  echo "compose.yaml pins $pinned but the newest server release is $newest." >&2
  echo "Update the tag and its digest together:  scripts/pin-compose.sh" >&2
  exit 1
fi

# The runbooks are copied and pasted as readily as the compose file, and
# docs/server.md went stale in exactly the same way it did.
stale=$(grep -rn "$image:[0-9][^@ ]*" docs README.md | grep -v "$image:$pinned" || true)
if [ -n "$stale" ]; then
  echo "these name an image tag that is not the pinned $pinned:" >&2
  echo "$stale" >&2
  exit 1
fi
echo "every image reference names $pinned"

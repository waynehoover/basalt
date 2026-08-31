#!/usr/bin/env bash
#
# Builds what the two releases are made of, and keeps them apart.
#
# They are separate releases because they are separate things on separate
# clocks. The plugin follows Obsidian's API and the community directory's rule
# that a release tag is exactly the manifest version, bare and with no `v`. The
# server is a protocol and a store, it should sit still, and it has no such
# rule. Nothing forces them to move together: what decides whether a client and
# a server can talk is the protocol version they each carry, checked on connect
# and refused on mismatch, and that is not the release number.
#
#   plugin, tagged  X.Y.Z          release/plugin/
#   server, tagged  server/vX.Y.Z  release/server/
#
# The plugin release holds exactly the three files Obsidian downloads and
# nothing else. Anything extra is a file the installer will never fetch and one
# more thing for a reviewer to ask about.
#
# The headless client is not here at all any more: it lives on npm, published by
# .github/workflows/npm-publish.yml, and a copy attached to a release is a
# second answer to "where do I get it".
#
# No uploading, no tagging, no publishing. It puts files in release/ and prints
# their checksums, then prints the two commands that would upload them. A script
# that makes decisions is one you cannot run to see what it would do.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
out="$root/release"

version=${1:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

rm -rf "$out"
mkdir -p "$out/plugin" "$out/server"

echo "basalt $version ($commit)"
echo

# ---- the server ----------------------------------------------------------
# Static, because the point of a single binary is that the machine it lands on
# needs nothing else. Pure-Go SQLite is what makes CGO_ENABLED=0 possible.
echo "server  ->  release/server/"
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  name="basaltd-$goos-$goarch"
  ( cd server && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out/server/$name" ./cmd/basaltd )
  printf '  %-24s %s\n' "$name" "$(du -h "$out/server/$name" | cut -f1)"
done

# ---- the plugin ----------------------------------------------------------
echo
echo "plugin  ->  release/plugin/"
( cd client && bun run build >/dev/null )

# Everything the build emits, rather than a list kept here by hand. That list
# said main.js and manifest.json, and styles.css was added to the plugin without
# it being updated, so a release would have installed a plugin whose history
# rows sit on top of one another and whose status bar has no colour. Nothing
# would have errored.
cp -R client/dist/plugin/. "$out/plugin/"

# And the ones it cannot do without, named so that a build which quietly stops
# emitting one fails here instead of shipping.
for required in main.js manifest.json styles.css; do
  [ -f "$out/plugin/$required" ] || { echo "release: the plugin build produced no $required" >&2; exit 1; }
done

minapp=$(python3 -c 'import json;print(json.load(open("manifest.json"))["minAppVersion"])')
pluginversion=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')

# versions.json maps a plugin version to the oldest Obsidian it runs on.
#
# It lives at the repo root, because that is where Obsidian reads it from, and
# is updated in place rather than generated fresh: an older entry is the whole
# point of the file, and rewriting it with only the current version would tell
# every older install that nothing it can run exists.
#
# It is not a release asset. Obsidian fetches it from the repository.
python3 - "$pluginversion" "$minapp" <<'PY'
import json, os, sys

version, minapp = sys.argv[1], sys.argv[2]
path = "versions.json"
known = json.load(open(path)) if os.path.exists(path) else {}
known[version] = minapp
with open(path, "w") as f:
    json.dump(known, f, indent=2)
    f.write("\n")
PY
rm -f "$out/plugin/versions.json"

printf '  %-24s %s\n' "main.js" "$(du -h "$out/plugin/main.js" | cut -f1)"
printf '  %-24s %s\n' "styles.css" "$(du -h "$out/plugin/styles.css" | cut -f1)"
printf '  %-24s %s\n' "manifest.json" "version $pluginversion, needs Obsidian $minapp"

# ---- checksums -----------------------------------------------------------
echo
( cd "$out" && find . -type f -not -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
echo "release/"
sed 's/^/  /' "$out/SHA256SUMS"

# ---- what to do with them ------------------------------------------------
# Printed rather than done. The tag is the decision and this is only what
# follows from it.
cat <<EOF

To publish the plugin, tagged bare because the community directory requires the
tag to be exactly the manifest version:

  git tag -a $pluginversion -m "Basalt Sync $pluginversion" && git push origin $pluginversion
  gh release create $pluginversion --title "Basalt Sync $pluginversion" \\
    release/plugin/main.js release/plugin/manifest.json release/plugin/styles.css

The attest workflow signs those three on publish and replaces them with what it
signed.

To publish the server, on its own tag because it moves on its own clock:

  git tag -a server/v$version -m "basaltd $version" && git push origin server/v$version
  gh release create server/v$version --title "basaltd $version" \\
    release/server/* release/SHA256SUMS

Pushing that tag is also what builds and pushes the container image.
EOF

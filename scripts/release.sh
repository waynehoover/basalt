#!/usr/bin/env bash
#
# Builds everything a release is: server binaries for the machines a homelab is
# likely to be, and the three files an Obsidian plugin is made of.
#
# No uploading, no tagging, no publishing. It puts files in release/ and prints
# their checksums. What happens to them afterwards is a decision, and a script
# that makes decisions is one you cannot run to see what it would do.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
out="$root/release"

version=${1:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

rm -rf "$out"
mkdir -p "$out/plugin"

echo "basalt $version ($commit)"
echo

# ---- the server ----------------------------------------------------------
# Static, because the point of a single binary is that the machine it lands on
# needs nothing else. Pure-Go SQLite is what makes CGO_ENABLED=0 possible.
echo "server"
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  name="basaltd-$goos-$goarch"
  ( cd server && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out/$name" ./cmd/basaltd )
  printf '  %-24s %s\n' "$name" "$(du -h "$out/$name" | cut -f1)"
done

# ---- the plugin ----------------------------------------------------------
echo
echo "plugin"
( cd client && bun run build >/dev/null )
cp client/dist/plugin/main.js "$out/plugin/main.js"
cp client/dist/plugin/manifest.json "$out/plugin/manifest.json"

# versions.json maps a plugin version to the oldest Obsidian it runs on, and
# Obsidian reads it to decide whether to offer an update to an older install.
minapp=$(python3 -c 'import json;print(json.load(open("client/manifest.json"))["minAppVersion"])')
pluginversion=$(python3 -c 'import json;print(json.load(open("client/manifest.json"))["version"])')
python3 -c "
import json
json.dump({'$pluginversion': '$minapp'}, open('$out/plugin/versions.json', 'w'), indent=2)
open('$out/plugin/versions.json','a').write('\n')
"
printf '  %-24s %s\n' "main.js" "$(du -h "$out/plugin/main.js" | cut -f1)"
printf '  %-24s %s\n' "manifest.json" "version $pluginversion, needs Obsidian $minapp"

# A folder ready to drop into .obsidian/plugins/, and the same thing zipped for
# anyone who would rather not.
( cd "$out" && zip -qr "basalt-plugin-$version.zip" plugin )

# ---- the headless client -------------------------------------------------
echo
echo "headless client"
cp client/dist/basalt.mjs "$out/basalt.mjs"
printf '  %-24s %s\n' "basalt.mjs" "$(du -h "$out/basalt.mjs" | cut -f1)"

# ---- checksums -----------------------------------------------------------
echo
( cd "$out" && find . -type f -not -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
echo "release/"
sed 's/^/  /' "$out/SHA256SUMS"

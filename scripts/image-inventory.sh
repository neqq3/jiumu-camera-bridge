#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Record the actual image, not versions inferred from a Dockerfile.
set -euo pipefail
image=${1:?image required}
output=${2:?output directory required}
mkdir -p "$output"
docker image inspect "$image" > "$output/image.json"
docker run --rm --network none --read-only --cap-drop ALL --entrypoint sh "$image" -c '
  node --version
  go2rtc --version
  ffmpeg -version
  ffmpeg -buildconf
' > "$output/runtime-versions.txt" 2>&1
docker run --rm --network none --read-only --cap-drop ALL --entrypoint dpkg-query "$image" \
  -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > "$output/debian-packages.tsv"
docker run --rm --network none --read-only --cap-drop ALL --entrypoint sh "$image" -c \
  'find /usr/share/doc /usr/share/licenses -name copyright -o -path "/usr/share/licenses/jiumu-camera-bridge/*" -type f | tar -czf - -T -' \
  > "$output/licenses.tar.gz"
sha256sum "$output"/image.json "$output"/runtime-versions.txt "$output"/debian-packages.tsv "$output"/licenses.tar.gz > "$output/SHA256SUMS"

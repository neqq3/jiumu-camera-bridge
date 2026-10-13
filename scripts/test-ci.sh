#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
image=${1:?pass an isolated candidate image}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
name="jiumu-ci-regression-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
tests=()
for file in "$root"/scripts/*.test.cjs; do
  # Ingress requires a dedicated namespace setup; the production image has no Python.
  [[ "$file" == */ingress.test.cjs ]] || tests+=("scripts/$(basename "$file")")
done
docker run --name "$name" --network none --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 768m --pids-limit 128 \
  --tmpfs /tmp:size=128m --log-opt max-size=10m --log-opt max-file=2 \
  -v "$root:/repo:ro" -w /repo --entrypoint node "$image" scripts/check.cjs
docker rm "$name" >/dev/null
docker run --name "$name" --network none --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 768m --pids-limit 128 \
  --tmpfs /tmp:size=128m --log-opt max-size=10m --log-opt max-file=2 \
  -v "$root:/repo:ro" -w /repo --entrypoint node "$image" \
  --test --test-concurrency=1 "${tests[@]}"

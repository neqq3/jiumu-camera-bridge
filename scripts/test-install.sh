#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Linux Docker only. Pass a freshly built image, never a production container.
set -eu
image=${1:-jiumu-bridge:0.1.0}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
name="jiumu-install-test-$$"
volume="$name-data"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --network none --init --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 64 \
  --tmpfs /tmp:size=32m --log-opt max-size=1m --log-opt max-file=2 \
  -e JIUMU_INSTALL_TEST=1 -v "$volume:/data" "$image" >/dev/null
# Copy public test code into tmpfs so host/NAS file ACLs cannot block the test.
docker exec -i "$name" sh -c 'cat > /tmp/install-test.cjs; chmod 644 /tmp/install-test.cjs' < "$root/scripts/container-smoke.cjs"
timeout --kill-after=3s 30s docker exec "$name" node /tmp/install-test.cjs check
timeout --kill-after=3s 30s docker exec "$name" node /tmp/install-test.cjs interrupt-rtsp
timeout --kill-after=3s 30s docker exec "$name" node /tmp/install-test.cjs port-conflict
docker restart -t 8 "$name" >/dev/null
docker exec -i "$name" sh -c 'cat > /tmp/install-test.cjs; chmod 644 /tmp/install-test.cjs' < "$root/scripts/container-smoke.cjs"
timeout --kill-after=3s 30s docker exec "$name" node /tmp/install-test.cjs check

#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
mkdir -p firmware-host-results
src=firmware/bk7252n
out=firmware-host-results
command -v ffmpeg
ffmpeg -version > "$out/ffmpeg-version.txt"
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x480:rate=10 -frames:v 1 -c:v mjpeg -huffman default -pix_fmt yuvj420p -q:v 5 -threads 1 -y "$out/test.jpg"
python3 "$src/tests/jpeg_headers.py" "$out/test.jpg"
flags=(-std=c99 -D_POSIX_C_SOURCE=200809L -DRESEARCH_HOST -Wall -Wextra -Werror -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie -I"$src")
gcc "${flags[@]}" "$src/tests/core_test.c" "$src/sp0a39.c" "$src/rtp_jpeg.c" -o "$out/core-test"
"$out/core-test" "$out/test.jpg" | tee "$out/core-test.log"
gcc "${flags[@]}" "$src/tests/host_server.c" "$src/rtsp_server.c" "$src/rtp_jpeg.c" -o "$out/host-server"
timeout --kill-after=5s 90s python3 "$src/tests/integration.py" "$out" | tee "$out/integration.log"
gcc "${flags[@]}" "$src/tests/maintenance_core_test.c" "$src/maintenance_core.c" -o "$out/maintenance-core-test"
timeout --kill-after=5s 90s "$out/maintenance-core-test" | tee "$out/maintenance-core.log"
gcc "${flags[@]}" -I"$src/tests/sdk_stubs" "$src/tests/test_maintenance_sdk.c" "$src/maintenance_sdk.c" "$src/maintenance_core.c" -o "$out/maintenance-sdk-test"
timeout --kill-after=5s 90s "$out/maintenance-sdk-test" | tee "$out/maintenance-sdk-test.log"
gcc "${flags[@]}" "$src/tests/maintenance_host.c" "$src/maintenance_http.c" "$src/maintenance_core.c" -o "$out/maintenance-host"
timeout --kill-after=5s 90s python3 "$src/tests/maintenance_integration.py" "$out" | tee "$out/maintenance-integration.log"
python3 -m unittest discover -s "$src/tests" -p 'test_*.py' -v 2>&1 | tee "$out/ota-tests.log"

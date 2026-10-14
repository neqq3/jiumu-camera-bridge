#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
root="$(pwd)"
results="$root/firmware-results"
mkdir -p "$results"
expected=1af1d4f549039bbecd7d07ffbbb7e24dc0bca57d
test "$(git -C sdk rev-parse HEAD)" = "$expected"
git -C sdk rev-parse HEAD > "$results/sdk-commit.txt"
sha256sum sdk/toolchain/arm-none-eabi-gcc.tar.xz > "$results/toolchain-sha256.txt"
printf '%s  %s\n' '0e8867ab3db3b25bc05f6ea4c3bfa5efe9163b5570f48ff86b6243d8ca576df2' 'sdk/toolchain/arm-none-eabi-gcc.tar.xz' | sha256sum -c -
tar -xJf sdk/toolchain/arm-none-eabi-gcc.tar.xz -C sdk/toolchain
export ARM_GCC_TOOLCHAIN="$root/sdk/toolchain/arm-none-eabi/bin/"
"${ARM_GCC_TOOLCHAIN}arm-none-eabi-gcc" --version > "$results/compiler-version.txt"
python3 firmware/bk7252n/prepare-sdk.py
git -C sdk diff -- application.mk beken378/app/config/sys_config_bk7252n.h beken378/func/camera_intf beken378/app/video_work/video_buffer.c > "$results/standalone-overlay.diff"
set +e
(cd sdk && timeout --kill-after=10s 600s make bk7252n -j2) 2>&1 | tee "$results/build.log"
status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$status" > "$results/build-exit.txt"
for name in bk7252n bk7231_bsp; do
  if [ -f "sdk/out/$name.elf" ]; then
    "${ARM_GCC_TOOLCHAIN}arm-none-eabi-size" "sdk/out/$name.elf" > "$results/$name-size.txt"
    "${ARM_GCC_TOOLCHAIN}arm-none-eabi-nm" -n "sdk/out/$name.elf" > "$results/$name-symbols.txt"
  fi
  if [ -f "sdk/out/$name.map" ]; then cp "sdk/out/$name.map" "$results/"; fi
done
if [ "$status" = 0 ]; then
  for symbol in video_buffer_open video_buffer_read_frame video_buffer_close camera_intfer_init sp0a39_init_candidate jpeg_parse rtp_jpeg_send research_rtsp_serve user_main; do
    if ! grep -Eq " [Tt] $symbol$" "$results/bk7252n-symbols.txt"; then
      printf 'Required implementation absent: %s\n' "$symbol" | tee -a "$results/symbol-validation.txt"
      status=1
    else
      printf 'Linked implementation: %s\n' "$symbol" | tee -a "$results/symbol-validation.txt"
    fi
  done
fi
printf '%s\n' "$status" > "$results/validation-exit.txt"
if [ -f sdk/config/sys_config.h ]; then cp sdk/config/sys_config.h "$results/"; fi
printf '## BK7252N compile-only research\n\nSDK: `%s`\n\nBuild exit: `%s`\n\nNo device access, flashing, deployment, or firmware release. A successful build does not establish A907-J board compatibility.\n' "$expected" "$status" >> "$GITHUB_STEP_SUMMARY"
# Only text diagnostics are uploaded. No vendor dump, ELF or flashable image.
exit "$status"

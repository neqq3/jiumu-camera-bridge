# BK7252N firmware research

This is an offline research implementation of a local RTSP application. It is not an
A907-J replacement firmware and must not be installed on a camera.

The first successful camera-API build and original-firmware SP0A39/pin/OTA
findings are recorded in [Board and upgrade findings](BOARD-AND-UPGRADE.md).

The workflow builds a fixed public SDK revision on GitHub-hosted runners:
[NonPIayerCharacter/beken_freertos_sdk, 1af1d4f](https://github.com/NonPIayerCharacter/beken_freertos_sdk/tree/1af1d4f549039bbecd7d07ffbbb7e24dc0bca57d).
It preserves build failures, compiler identity, linker maps and symbol lists.
It does not publish flashable binaries, use household credentials, access camera
hardware, or change the bridge container and Home Assistant add-on releases.

The first unmodified SDK attempt failed at link time. The standalone overlay
includes the SDK's own BLE-disabled compatibility implementation and supplies
the hostname callback expected by its OpenBeken-modified lwIP port. It retains
libc functions needed by LTO and explicitly links the real camera frame API;
these functions are not replaced by success-returning test doubles.

The overlay now replaces the SDK's GC0310 default with a chip-ID-checked
[SP0A39 candidate](SENSOR.md). It links a real SDK frame provider and a portable
RTSP 1.0 / RTP-JPEG server: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER and
TEARDOWN; one client; TCP interleaving; VGA delivery capped at 10 fps.
JPEG parsing validates quantization and standard Huffman tables, supports
4:2:2/4:2:0 baseline frames, and rejects unsupported scans and oversized frames.
Buffers are capped at 64 KiB per frame, 2 KiB per request and 1400 bytes per
packet. Partial requests expire after 5 seconds; writes after 2 seconds; a
session with no valid fresh frame closes after 5 seconds.

The research entry point waits for SDK initialization and starts the service on
**loopback only**. It has no Wi-Fi onboarding, user authentication, audio, LAN
enable switch or OTA endpoint yet. It is not a usable camera replacement.
No household credentials or cloud endpoints are compiled in. Library code is
not a packet capture: cloud-free operation on hardware remains untested.

[Actions run 38589129001](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38589129001)
compiled the adapter and actual frame/server implementations. An independent
Linux job ran the same protocol C code with ASan/UBSan and synthetic FFmpeg
input: two RTSP connections each decoded 12 VGA frames. This proves protocol
interoperability, not sensor output, hardware performance, recovery or long-term
stability. No real camera images are used by CI. The first implementation run
failed; its diagnostics remain available alongside the successful retry.

The linked image uses 440,548 bytes of text, 756 bytes of data and 101,664 bytes
of BSS in that run. The 64 KiB frame buffer, SDK video pool, RTOS tasks and network
buffers also consume heap. A successful link is not a runtime memory test.

The public SDK contains precompiled radio/calibration libraries. Public source
availability does not mean every component is open source or cleared for binary
redistribution. The current experiment publishes text compilation evidence only.

The [OTA and recovery investigation](OTA-RECOVERY.md) describes what can and
cannot be established without the installed bootloader. `ota_preflight.py`
inspects a local stock-format RBL file without any device connection; passing
its format checks always leaves `safe_to_flash` false. No firmware image or
flasher is distributed by this workflow.

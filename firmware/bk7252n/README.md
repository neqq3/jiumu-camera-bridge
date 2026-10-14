# BK7252N firmware research

This is a compile-only experiment toward a local RTSP application. It is not an
A907-J replacement firmware and must not be installed on a camera.

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

The SDK's GC0310 default does not identify the sensor fitted to any particular
retail camera. Board-specific sensor, GPIO, flash layout, bootloader and recovery
compatibility must be established independently before a hardware trial.

The public SDK contains precompiled radio/calibration libraries. Public source
availability does not mean every component is open source or cleared for binary
redistribution. The current experiment publishes text compilation evidence only.

Next stages: identify the original board configuration, link the camera frame
API in a minimal application, implement RTSP/RTP JPEG output with bounded memory,
and establish a recoverable OTA migration path before any separately authorized
flashing. There is currently no claim of hardware-tested native RTSP.

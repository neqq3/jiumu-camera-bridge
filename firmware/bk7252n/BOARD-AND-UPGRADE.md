# A907-J: static board and upgrade findings

Status: offline research, 2026-10-14. No camera was contacted, rebooted, reset or
flashed for this work. Existing bridge and Frigate installations were untouched.

## Evidence boundary

The locally held original application identifies itself as `21.120.101.42`.
Its decoded SHA-256 is
`cc2ad73144c5f61062be7cc4c465766a35c200ec4274006ccb1339620f460749`.
Addresses below are virtual addresses with image base `0x10000`.
The original binary and extracted register table are not redistributed here.
Analysis used standalone Ghidra because the installed REA Windows provider did
not support this raw ARM image. This is static evidence, not a new hardware test.

## Sensor and camera interface

The active camera initialization function at `0x29824` opens `i2c1`, addresses
the sensor at `0x21`, writes 382 register/value pairs, and logs
`SP0A39 init finish`. This strongly identifies the firmware's configured sensor
as **SP0A39**. A live chip-ID read and physical package inspection were not done.
The 764-byte table at `0xf9f31` has SHA-256
`08b5f5aa182a2f0a400c9da65827bba630d4193c9f6c71b483c7ab17c50e71e2`.
It is not the GC0310 selected by the public SDK's current default configuration.

The original JPEG setup path `0x2bc98 -> 0x2b7f8 -> gpio_ctrl(0x22ffc)` enables
pin-mux modes `0x2f`, `0x2d`, `0x2e`, `0x2c`. Reading the original mux tables
gives the following GPIO groups; signal names are corroborated by the
[BK7252N datasheet, section 3](https://datasheet.lcsc.com/datasheet/pdf/bbe37b9852491bcf4ddc67707e7a4d3b.pdf?productCode=C53282001)
and the pinned SDK's GPIO driver.

| Signal | GPIO | Evidence |
| --- | --- | --- |
| SCCB/I2C SCL, SDA | 20, 21 | `i2c1` control bus; original mux mode `0x16` maps 20–21 |
| Camera MCLK | 27 | Original mux mode `0x2c` |
| Pixel clock | 29 | Original mux mode `0x2f` |
| HSYNC, VSYNC | 30, 31 | Original mux mode `0x2d` |
| D0–D7 | 32–39 | Original mux mode `0x2e` |
| Sensor RESET / PWDN | Unconfirmed | Do not substitute the SDK's unused GPIO16 reset macro |

The original clock selectors match the SDK's 24 MHz MCLK configuration. This
is an inference from matching register-control code, not a scope measurement.
These are SoC GPIO numbers, not connector positions or package pad numbers.

An independently licensed implementation exists in
[Espressif's SP0A39 driver](https://github.com/espressif/esp-video-components/tree/master/esp_cam_sensor/sensors/sp0a39).
Its sensor probing and register definitions are useful references, but its
ESP32 peripheral implementation is not a BK7252N driver.
[XF16Cam](https://github.com/divadiow/XF16Cam) also supports this sensor and
RTSP, but targets an XR872ET-family processor. Its firmware cannot be installed
on a BK7252N merely because both devices are sold as A9 cameras.

## Candidate upgrades without opening the camera

**Network OTA is the preferred research route.** The original TCP server
connection feeds event `0x12` to the control-event handler at `0x4200c`.
Its `ota_upgrade` branch reads `version`, `force`, `host`, `file` and optional
`taskId`, constructs an HTTP URL from host and file, and calls the downloader
at `0x3bfc4`. No fixed vendor hostname comparison was found in this handler.
It stages the image in the `download` partition, verifies it and reboots after
success. A local HTTP host is therefore plausible without adding an SD card.

This is a command received through the device's configured server connection;
it is **not evidence of an unauthenticated HTTP upload page on the camera**.
Using the existing local server replacement for this control command remains
untested. No OTA command, including a deliberately invalid test command, was
sent during this investigation.

**SD-card upgrade is a second candidate.** The application's mounted-card path
calls a directory scanner at `0x3ca00` before its factory-configuration parser.
The scanner requires the version-family prefix, `.bin` suffix, and a newer
numeric revision before an underscore. The selected file passes through
`0x3c518`, which writes the `download` partition in blocks with readback
comparison and calls the same firmware verifier. A random binary renamed to
match the filename is not a compatible firmware package.

Both paths include RBL header/body CRC checks. These are integrity checks;
they do not establish cryptographic signature enforcement or safe rollback.
The available OTA application image does not contain a full backup of this
camera's bootloader, partition metadata and device-specific calibration data.

The SD scanner belongs to the running application. If a replacement fails
before that code runs, inserting a recovery card may do nothing. Neither A/B
rollback nor bootloader-level SD recovery has been established. A developer
may still need UART access to recover an experimental unit. That does not mean
normal users must desolder a flash chip; it means a dependable no-disassembly
migration path has not yet been demonstrated.

## Build result and next gate

[GitHub Actions run 38561397177](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38561397177)
successfully compiled and linked the pinned SDK plus the documented standalone
overlay. The final symbol inventory includes `camera_intfer_init`,
`video_buffer_open`, `video_buffer_read_frame` and `video_buffer_close`.

The linker reports 432,328 bytes of text, 756 bytes of initialized data and
101,664 bytes of BSS. This is not a runtime heap or frame-rate measurement.
The first run failed at link time; the second built but failed the required
frame-buffer-symbol check. Both failures remain in Actions history.

Next work is a board-specific SP0A39 adapter and a bounded RTSP/RTP-JPEG
application with local configuration. The successful SDK build still uses its
default sensor and demo application; it is not already a cloud-free RTSP image.
Before any separately authorized hardware trial, establish the original
bootloader/partition contract and a recoverable migration path. Preserve the
original bootloader and RF calibration unless independent evidence requires
otherwise. No firmware image is released by this workflow.

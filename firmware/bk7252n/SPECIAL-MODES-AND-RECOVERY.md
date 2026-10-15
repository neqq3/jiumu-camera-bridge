# Special modes, network OTA, and failed-boot recovery

Updated 2026-10-15. Offline analysis only: no camera connection, reset, mode
change, firmware transfer, or production configuration change in this pass.
Standalone Ghidra and Capstone were used for the raw ARM target, outside REA's
unsupported Windows raw-firmware provider. Stock addresses below refer to the
decoded application with SHA-256
`cc2ad73144c5f61062be7cc4c465766a35c200ec4274006ccb1339620f460749`.

**Local network installation remains plausible. No-disassembly backup and
recovery from a nonbooting replacement remain unproven.** Normal OTA in both
directions and recovery when neither application runs are separate requirements.

## What the stock buttons actually reach

The application initializer `0x3627c` calls `gpioInit` at `0x3ad34`. That
registers `key_event_handle` (`0x3abb0`) and creates the GPIO thread (`0x3a748`).
These are RTOS application routines, not code from the missing boot region.

The GPIO thread samples SoC GPIO2 for the software SYS key, GPIO12 for MODE,
and GPIO4 for charging status. Software names are not a verified mapping to
the retail enclosure's button labels. The reviewed state machines distinguish
short, long and release events; no combined-button recovery branch was found
in this thread. That does not exclude different behavior in an unknown loader.

On MODE release after its long-press state, outside product-test mode, the
handler calls `0x39f64`. This restores the EasyFlash defaults via `0x33314`,
writes the existing device ID and code back via `0x47160`, stores the clock,
and reboots. This resets configuration; it does not restore application bytes.
The SYS path instead reaches recording stop and power/sleep handling.

One decompiler boundary needed correction: `0x2795c` calls the non-returning
watchdog reboot routine `0x278fc(1)`. Ghidra initially included the following
SoftAP initializer at `0x27964` in the same function. Capstone confirms the
boundary. The adjacent SoftAP text is **not** evidence of a rescue AP reached
after reboot failure.

The `start_type` initialization (`0x25800`) classifies reset/wakeup causes.
Its presence does not establish a selectable USB/download mode. The reviewed
factory `reset_key_down` test at `0x410b4` polls a GPIO; it is not a flash-read
or bootloader-entry command. None of these paths was exercised on hardware.

## Network OTA details relevant to switching back

Two original entry paths reach the same HTTP downloader (`0x3bfc4`):

| Entry | New detail | Limit |
| --- | --- | --- |
| Configured server's `ota_upgrade` branch at `0x4200c` | With `force == 1`, the application skips its version comparison. Otherwise it skips an exactly equal version string; this branch does not require a numerically newer version. | This is not proof that the installed loader permits downgrade or accepts a custom image. |
| Authenticated private-protocol `auto_download_file.cgi` at `0x4a3c0` | Parses server/file/optional port and replies before calling the downloader with no progress callback. No version comparison appears in this handler. | An initial successful response means command acceptance, not completed flash or healthy boot. This is not a general HTTP upload/download page. |

The downloader writes the `download` staging partition and verifies the
package before rebooting. It is not a flash-export service. It also changes
flash-protection settings through `0x274bc`, including its cleanup path.
Invalid-image or empty-file experiments are not read-only diagnostics.

The persisted `isOtaFlag` is not demonstrated to be a rollback marker:
the downloader sets it when using a callback, configuration initialization
loads it, and TCP registration code `0x44014` clears it and calls `0x40bd4(0)`
to report the running version to the server. This reviewed path has no
old-image selection or loader health acknowledgement. Do not equate a server
OTA status report with boot-level recovery.

A custom return-to-stock service would need the correct original RBL, verified
installed partition bounds, and a working network/maintenance path independent
of the camera sensor. It must preserve identity/calibration and compatible
stock settings. Returning application code alone does not necessarily restore
the original cloud-server configuration. This service is not implemented yet.

## The reference loader's recovery message is not automatic restoration

The separately held SDK reference loader has SHA-256
`c8cfbcfb4b2b60f4fd91cc4651e5ab4c4afc192c52117dd4965d00935740c88b`.
It has **not** been identified as this camera's installed loader.

Following its previously reviewed `ota_main` at `0x999c` to its caller reveals
an important limit: at `0xaaf4`, a nonzero result sets the launch address back
to logical `0x10000` and proceeds toward application transfer. It does not
select a separate known-good/factory image. Thus a log saying factory recovery
is needed, followed by a jump to `0x10000`, is not proof that recovery occurred.

The same reference rejects a destination named `bootloader`, and rejects
unencrypted OTA through the reviewed main path. After a successful copy it
erases the staging header before starting the new application. Its potential
retry of an interrupted copy is not rollback of a checksum-valid bad app.
Neither these restrictions nor its fallback behavior may be asserted for the
installed loader until that loader has been read and identified.

## Independent recovery and the enclosure boundary

The [manufacturer's BK7252N quick-start guide](https://docs.riselink.ai/wifi/bk7252n/en/latest/get-started/index.html)
documents UART flashing. The
[current chip datasheet](https://datasheet.lcsc.com/datasheet/pdf/bbe37b9852491bcf4ddc67707e7a4d3b.pdf?productCode=C53282001)
labels download UART on P10/P11 and download SPI on P20-P23. Its UART numbering
differs from legacy SDK naming; use the signal/pin mapping, not `uart1` alone.
The ordinary SD signals are not those download pins. An SD slot supporting
normal SPI operation is not evidence that it exposes the chip's download SPI.
No wiring or adapter assumption has been tested on this camera.

The upstream author's [BK7252N camera investigation](https://www.elektroda.com/rtvforum/topic4118499.html#21526681)
reports complete flash readout via board RX1/TX1, whereas the older BK7252 mode
skipped the boot region. This is evidence on another board, not our enclosure.
The pinned [Easy Flasher implementation](https://github.com/openshwprojects/BK7231GUIFlashTool/blob/d033bf111cd46d9b7f4e4f86ed371bb0255a7307/BK7231Flasher/Flashers/BK7231Flasher.cs)
distinguishes BootROM and BL2 and has a BK7252N direct-flash profile. Its setup
still toggles reset signals, requests reboot and changes baud rate even for
readout. It was not executed.

This makes UART a credible development-unit backup/recovery candidate that
does not inherently require removing the flash chip. It does **not** establish
no-disassembly access, or prove this unit remains recoverable after arbitrary
flash corruption. The retail USB wiring and usable download handshake remain
unknown; normal USB enumeration found no camera candidate even after a cable
change. No documented button combination for this exact model was found.

## Decision by failure stage

| State | Candidate action | Present confidence |
| --- | --- | --- |
| Stock app works | Local HTTP image fetched through an existing authenticated OTA control path | Static path established; migration not attempted |
| Custom app and maintenance networking work | Validate/stage the preserved stock package, then reboot | Design only; return service missing |
| New package download is incomplete | Retain existing app; loader validates staging before copy | Application staging established; installed loader still missing |
| Power fails while copying | Retry intact staging if the loader supports it | Reference inference only; no power-cut test |
| Sensor init fails but early maintenance survives | Reach maintenance and reinstall stock | Future design; no hardware proof |
| Application fails before networking | Boot-level fallback or independent download interface | No verified no-disassembly route |
| Loader or partition data are damaged | Independent ROM/SPI recovery with original data | Chip/tool support is not a tested route on this unit |

Current blockers are the actual boot/FAL readout and a demonstrated external
recovery path. More SDK compilation cannot establish either. No firmware was
sent to a camera and no new flashable image was created by this investigation.

See [the readout investigation](READOUT-AND-SWITCHING.md) and
[OTA package/recovery analysis](OTA-RECOVERY.md) for the existing evidence.

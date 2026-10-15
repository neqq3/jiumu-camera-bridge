# Read-only backup and reversible firmware migration

Updated 2026-10-15 (Asia/Shanghai). The first pass used the already held stock
application and Android APK offline. A follow-up sent one bounded HTTP status
request from each of two existing hosts and read the existing Frigate camera
statistics. The camera's HTTP port refused the NAS connection; Frigate still
reported 5 FPS and zero skipped FPS at that observation. No firmware version
was recovered from those requests. No upgrade, restart, flash, configuration
or network change was made.
The intended outcome is **stock to local firmware and back without opening
the enclosure**, including a separately proven recovery path for failed boots.
That outcome is not implemented or hardware-validated.

## Readout candidates checked

Addresses below refer to the decoded stock application based at `0x10000`;
APP addresses refer to the ARM64 Flutter AOT library. These are static findings,
not an exhaustive proof that no other interface exists.

| Candidate | Evidence | Readout conclusion |
| --- | --- | --- |
| `auto_download_file.cgi` | APP `updateFirmware` at `0x1edc2dc` builds this command. Camera handler `0x4a3c0` constructs an HTTP URL and calls OTA downloader `0x3bfc4` after its response. | Downloads **into** the camera and writes staging. Not a firmware backup API. Do not use even an invalid image to test it. |
| `get_factory_param.cgi` | Handler `0x48164` reports fixed capability fields after authentication. | No bootloader bytes or partition table in this handler. |
| `get_record_file.cgi`, `get_record_idx.cgi`, `get_record.cgi` | `0x49120`, `0x494fc`, `0x49964` enumerate dated SD recording indexes or return recording/card settings. Index paths are constructed under `/sd/video`. | Not demonstrated to export arbitrary flash. No traversal or malformed-path testing performed. |
| HTTP port 81 | Previously identified handler `0x4636c` recognizes `GET /get_status.cgi`. | No generic file download or shell demonstrated. |
| TCP control / `trans_cmd_string.cgi` | Existing dispatchers `0x43ef8`, `0x4200c`, `0x37100`, `0x48ad4` and the normal/factory connection setup were reviewed. | No flash-read command found in the reviewed paths; several commands change settings, power or firmware. No blind command probing. |
| `fal read` | Shell command table at `0xf3868` points to `0x642f8`. The read branch calls the selected flash-device reader or partition reader `0x640b0`, then prints a hex dump. | A genuine read primitive exists, but a no-disassembly transport to it is missing. |
| Shell console | Board initialization `0x3028c` selects `uart1` through `0x4bf58`. `0x55890`/`0x558b8` attach standard streams to `/dev/<console>`. Finsh thread `0x54264`/`0x54334` reads standard input via `0x54308`. | Evidence currently leads to UART, not to a network shell or externally accessible USB console. |
| APP string `bootloader` | Pool `0xa1d8`, used at `0x1515e64` in `device_info_plus` AndroidDeviceInfo.fromMap. | Describes the **Android host**, not the camera bootloader. |
| SD `product_test.txt` | Parser `0x42690` accepts a fixed set of JSON provisioning/test fields; prior lifecycle analysis follows its server events. | Not an arbitrary script runner or flash-dump request. Inserting it changes operating mode and can reconnect Wi-Fi. It was not used in this read-only investigation. |

The generic strings `USB Slave Device` and `USB Host Bus` belong to an RT-Thread
device-type name table. They do not establish that the retail USB connector
exposes USB CDC, DFU, storage, a console, or recovery. Its wiring remains unknown.

The installed FAL table is still missing. The known application searches
backward from logical `0xf000` for it, outside the available app-only OTA image.
See [OTA recovery](OTA-RECOVERY.md) for the original package and separate SDK
reference bootloader. Neither reference data nor a matching product name is a
substitute for a boot-region dump from this camera.

## Network and USB follow-up

The reviewed socket listener chain is `0x53d3c` → `0x58758` → `0x56578`.
Its identified application callers lead to the following services; this is
static call-graph evidence, not a port scan or proof against indirect callers.

| Service | Code path | Implication for backup |
| --- | --- | --- |
| HTTP 81 | `0x4636c` | Status-only handler already reviewed; current live request was refused. |
| TCP 7050 demo | `0x1e494`, started by `0x1e784` | Accepting a client initializes the video/SPI/DMA transfer path (`0x29e14`) and echoes received data. Merely connecting is not a harmless readout probe. |
| TCP 10002 local stream | `0x383ec`, started by `0x387f8` | Started by the `localstream start` console handler `0x389dc`; reviewed receive path is stream framing, not a flash reader. Not enabled or contacted. |
| UDP 7080/7090 demo | `0x1e810`, started by `0x1ebc0` | Includes video start/stop and UART byte forwarding. `0x1bbcc` writes UART TX registers; it does not feed shell standard input. |

The demo servers' reviewed callers are Wi-Fi demo threads, reached through
the console handler `0x1f6c0`. Enabling them can change Wi-Fi/video operation.
No demonstrated path connects these services to the genuine `fal read`
console primitive. No test command, malformed packet, or demo connection was
sent to the camera.

Do not infer BK7252N USB support from the older **BK7252**:

- The manufacturer **BK7252N DS-BK7252N-C04 V1.3 (2025-02-11)** lists USB
  supply/charging (`VCCUSB`), but its peripheral list and reviewed pin tables
  do not document a USB data controller or DFU. See the
  [manufacturer datasheet, hosted by LCSC](https://datasheet.lcsc.com/datasheet/pdf/bbe37b9852491bcf4ddc67707e7a4d3b.pdf?productCode=C53282001).
- The selected public SDK's BK7252N configuration sets `CFG_USB` and
  `CFG_USE_USB_HOST` to zero. Its USB source is shared with other SoCs. This
  reference configuration does not establish the retail board's build.
- The retail application's additional USB strings say charging plug-in/out.
  Suspected `0x8040xx` register literals checked at `0x33dd0` and `0xc18dc`
  were instruction bytes inside crypto routines, not USB register accesses.
  Device-type strings likewise do not establish a USB driver.
- An external USB–UART bridge or UART signals routed to the connector would
  depend on the product's wiring. No descriptor capture or wiring evidence
  is available for this unit. Failure to enumerate would not by itself prove
  there are no UART signals on that connector.

A bounded read-only PnP metadata query on the user-confirmed Windows USB host
found 31 present USB nodes and one motherboard ACPI COM port. The USB nodes
were attributable to existing peripherals; no camera, USB serial or recovery
candidate was identified. The supplied cable's data capability is unverified.
This observation does not establish a power-only connector or exclude a
different device mode. No port was opened, cable unplugged, driver installed,
or reset triggered. A prior inventory of the wrong host was discarded as
camera evidence. The actual camera bootloader and FAL table remain unread.
After the user replaced the cable, a second bounded query returned identical
device instance hashes and collected metadata, with no additions or removals.
The replacement cable's data capability was not independently tested. This
still provides no accessible USB readout path in the observed operating mode.

There is a **distinct UART BootROM recovery candidate** for BK7252N. The
[Easy Flasher source at d033bf1](https://github.com/openshwprojects/BK7231GUIFlashTool/blob/d033bf111cd46d9b7f4e4f86ed371bb0255a7307/BK7231Flasher/Flashers/BK7231Flasher.cs)
uses the direct-flash profile for BK7252N and distinguishes BootROM from BL2
link responses. This is tool support, not a successful handshake with our
camera and not evidence of USB recovery or automatic OTA rollback.

At that exact revision, `doReadInternal` calls `doGenericSetup(false)` and
skips the flash-protection modification branch. However, setup still toggles
DTR/RTS, sends `reboot`, and changes the UART baud rate. It cannot be used as
an uninterrupted live-backup tool. Older tool logs and different modes must
not be assumed to have the same non-writing behavior. No flasher was run.

## Compiled SDK layout is not the installed FAL table

A second partition mechanism exists in the original application. SDK startup
`0x2387c` calls `0x276c8`, which stores `0xf94d8` in RAM pointer `0x40d008`.
Getter `0x27458` selects one of eight 20-byte records. These **application
constants** describe the following layout; empty records 5 and 6 are omitted.
They were extracted offline, not read from the camera.

| SDK record | Start | Length | Preservation concern |
| --- | --- | --- | --- |
| Bootloader | `0x000000` | `0x00f000` | Not a complete backup extent for the boot/FAL region |
| Application | `0x011000` | `0x121000` | Physical interval corresponding to a CRC-interleaved application |
| ota | `0x132000` | `0x0ae000` | Ends at `0x1e0000`; temporary package, not a second bootable app slot |
| RF Firmware | `0x1e0000` | `0x001000` | Preserve radio data |
| NET info | `0x1e1000` | `0x001000` | Preserve stock network data |
| ble bonding info | `0x1f0000` | `0x001000` | Preserve stock pairing data |

The application interval matches the separate SDK reference loader after
32-byte logical blocks are mapped to 34-byte physical blocks: logical
`0x10000 + 0x110000` becomes physical `0x11000 + 0x121000`. The staging offset
and length also match. **This narrows the layout hypothesis; it does not
identify the installed loader.** The boot entry differs from the reference
FAL boot partition's size and must not be used to truncate a backup. Gaps in
this legacy table are not proof of unused flash or permission to repartition.

Both FAL device descriptors in the application advertise `0x400000` bytes.
That constant is not a measurement of the retail flash capacity. The real
device ID/capacity, boot bytes, FAL records, and any unlisted configuration
regions still need readout before constructing a flashable migration plan.

The CGI dispatcher at `0x37100` recognizes 21 command names in the examined
image. The additionally reviewed `get_params.cgi` (`0x47f08`) and
`get_camera_params.cgi` (`0x483b4`) serialize network/image settings and feature
flags, not arbitrary flash bytes. A reported CPU or factory-mode field is
not itself a debug-read interface. Those requests were not sent to hardware.

## What reversible switching would require

The preferred design is **application-only migration with the original loader
and device-specific data preserved**. This is a design constraint, not a
statement that today's research image can be flashed.

1. Obtain and identify the actual loader, FAL table, flash capacity and relevant
   configuration/calibration regions. Record both physical and CPU-visible
   addresses; their CRC interleaving differs. A backup must identify its device
   and format and be read twice with matching hashes. Keep it private.
2. Preserve a verified stock application package, plus the board's original
   configuration and radio/identity data. An app-only package is useful for
   returning to stock but is not a full-device backup. Returning to stock must
   also handle any previously changed server settings; restoring code alone
   does not necessarily restore factory cloud connectivity or account state.
3. Stock to custom: retain the existing app-level network OTA as a candidate,
   package for the **installed** loader, and write only verified staging/app
   areas. No replacement loader or repartitioning is part of this initial path.
4. Custom to stock: implement a local authenticated maintenance interface that
   can validate and stage the verified original package for the same loader.
   Start maintenance independently of sensor/audio initialization. Isolate
   custom settings so they cannot overwrite stock identity/calibration data.
   The [interface and SDK backend are now implemented and host-tested](LOCAL-MAINTENANCE.md).
   Device provisioning and the installed boot contract remain unverified; the
   research board configuration does not enable its listener or writes.
5. Verify a complete stock → custom → stock → custom cycle on a recovery-ready
   spare under separate flashing authorization. Check cold boot, local access,
   sensor/audio, configuration preservation and the existing video integration.
   Firmware switching necessarily includes an interruption/reboot; it is not
   seamless switching of a running video stream.

Normal network re-flashing does not require two bootable app slots. **Automatic
rollback from an early crash does** require independent boot-level support or
another verified rescue mechanism. The available SDK reference cannot supply
that guarantee: its observed copy path invalidates the staging header before
launching the application and has no health acknowledgement at that point.
It has not been identified as the camera's installed loader.

## Recovery acceptance criteria

| Situation | Required behavior | Current evidence |
| --- | --- | --- |
| Both applications work | Repeatable local OTA in both directions, preserving original data | Stock download path identified; custom return interface implemented; actual round trip untested |
| Sensor fails but custom app runs | Local maintenance remains usable | Separate task implemented; not tested on hardware |
| HTTP download stops midway | Old app remains bootable; incomplete staging rejected | Application writes staging; actual loader behavior unresolved |
| Power fails during app copy | Loader can resume or use an intact alternative image | Installed loader required; no power-loss test |
| Valid image hangs before networking | Independent rescue or bounded trial-boot rollback | Not demonstrated; application watchdog/maintenance cannot guarantee this |
| Boot region or flash map is wrong | Existing recovery interface remains available | Avoid modifying them; no verified external USB rescue |

The next useful evidence is a verified non-writing transport to the installed
shell, a manufacturer diagnostic/export interface, or a full dump from the
same board/firmware that can first be identified against this device. A dump
from another unit can inform research but must not transplant its device data.
Installing a helper firmware merely to obtain a first backup would already
change the application and would not satisfy the current read-only constraint.

Related upstream work documents UART/SPI access rather than proving an external
USB or network recovery path for this board:
[beken7252-opencam memory access](https://github.com/daniel-dona/beken7252-opencam/wiki/Reading-and-writing-chip-memory),
[bk7252-cam tooling](https://github.com/Apache02/bk7252-cam).
Those boards, bootloaders and UART assignments must not be assumed identical.

Current status: **no actual-camera bootloader or partition dump obtained; no
safe-to-flash or arbitrary-failure recovery claim**. The existing RTSP build and
CI results remain protocol/compile evidence only.

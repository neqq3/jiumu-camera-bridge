# Network OTA and failure recovery

Implementation update: [local maintenance and stock return](LOCAL-MAINTENANCE.md)
now has a real SDK backend, authenticated HTTP interface and host fault tests.
It requires an independently established installed-loader contract and does not
enable Flash writes in the checked-in research board configuration. It does not
change the unverified first-backup and early-crash recovery boundaries below.

Latest offline follow-up, 2026-10-15:
[special modes, version checks and error fallback](SPECIAL-MODES-AND-RECOVERY.md).
In the reference loader, `ota_main` returning an error leads its caller to
attempt logical `0x10000`, not to restore a separate factory image. The installed
loader remains unidentified. Stock key handling resets settings, while the
reviewed `isOtaFlag` path reports an update result to the server.

Follow-up 2026-10-15: [read-only readout and bidirectional switching](READOUT-AND-SWITCHING.md)
tracks the installed-loader search. A real `fal read` shell primitive is present,
but an external network or USB transport has not been demonstrated. The APP's apparent
download command is an OTA writer, not a backup interface. The initial analysis
was offline; the follow-up separately records bounded status-only requests.
No upgrade, flash, restart or configuration change was made.

Updated 2026-10-14. No camera, router, NAS, Android device or Frigate instance
was accessed for this investigation. It uses the already held original
application and a separately identified public SDK reference. Standalone
Ghidra was used because the installed REA provider does not handle this raw
ARM target on Windows. No upgrade command or image was sent to hardware.

## What supports an upgrade without opening the enclosure

The original control flow is:

`configured TCP server -> event 0x12 -> control handler 0x4200c -> ota_upgrade
-> HTTP downloader 0x3bfc4 -> download partition -> verifier 0xd70a4 -> reboot`.

The handler accepts version, force, host, file and optional taskId fields. It
constructs an HTTP URL from host and file. No fixed vendor-host comparison was
found in this branch. Using the existing local server replacement and a local
HTTP file service is therefore a credible **candidate** for network migration,
without an SD card, USB Wi-Fi adapter, Bluetooth adapter or disassembly.
This is not a proven migration and not an HTTP upload page on the camera.
No ready-to-send upgrade command or automatic flasher is included here.

The downloader checks HTTP response/length and partition capacities, writes
the staging partition in blocks with readback comparison, and performs package
verification before requesting reboot. It writes staging while downloading,
before final whole-package validation. It does not itself implement A/B boot
selection, a trial-boot counter, or a healthy-application acknowledgement.

## Why the installed bootloader is the remaining critical evidence

The original FAL initializer at **0x63dfc** searches backward from logical
**0xF000** in `beken_onchip_crc` for magic **0x45503130**, then reads 64-byte
partition records into RAM. The application therefore obtains its partition
table from the earlier boot region. Our decoded OTA application starts at
**0x10000** and does not include that region. The **installed FAL table** cannot
be recovered from this application alone. A separate, compiled legacy SDK
partition table has now been extracted from the application at `0xf94d8`:
see [its layout and limits](READOUT-AND-SWITCHING.md#compiled-sdk-layout-is-not-the-installed-fal-table).
That table is useful corroboration but does not contain the bootloader or
identify the FAL table that the installed bootloader actually provides.

The known original RBL is 659,424 bytes; its decoded application is 1,111,392
bytes. Its format is **0x402 (AES256-CBC plus LZMA)**. Header and packaged-body
CRCs and the decoded raw FNV hash have been verified locally. The custom
raw-verification hook at **0xd6fd0** returns zero; it adds no signature check in
this application. This does not rule out a different bootloader-side check.
The RBL's version field is `1.0.1`, while the application identifies itself as
`21.120.101.42`: these version fields must not be conflated.

The SDK's convenience `build.sh` chooses gzip, while the observed stock RBL
uses LZMA. A normal SDK build also emits whole-flash/QIO files. Neither should
be renamed and treated as a stock-compatible OTA image. Execution address,
CRC encoding, raw versus packaged bytes, partition bounds and metadata must
all match the installed bootloader. The SDK partition JSON is an example,
not evidence of the retail board's flash map.

For comparison only, the pinned SDK's `bootloader_bk7252n_uart1_v1.0.15.bin`
has SHA-256 `c8cfbcfb4b2b60f4fd91cc4651e5ab4c4afc192c52117dd4965d00935740c88b`.
Its table names `bootloader`, `app`, and `download`. Further disassembly of
this **reference** establishes:

- `0x999c` checks staging and runs the upgrade. Error messages asking for
  factory recovery lead to an error return; those branches do not load a
  factory image.
- `0xa7bc` copies/decompresses, checks the new raw image, then writes its
  application metadata. After a successful return, `0x98d8` erases the
  download header before the main application is started.
- `0xa07c` compares staging and application headers. If staging remains intact
  and the application header is invalid/different, retrying an interrupted copy
  appears possible. This is a static inference, not a power-cut test.
- This path has no application-health acknowledgement before staging is
  invalidated. A checksum-correct application that hangs will not trigger a
  health-based rollback through this mechanism. There is no old-app slot in
  this reference partition table.

The reference has **not** been identified as the bootloader installed in this
camera. It cannot establish this camera's recovery behavior. Other BK7252/A9
projects cannot supply that missing identity merely by sharing a product name.

## Failure cases and their current status

| Failure point | What is established | Still required |
| --- | --- | --- |
| HTTP download interrupted | Original downloader writes staging, not the running app | Confirm installed bootloader rejects incomplete staging on power-up |
| Corrupt or truncated package | Original application checks header/body integrity; offline preflight rejects all tested truncations and byte corruption | No physical power-cut test performed |
| Power lost while bootloader copies/decompresses | Application code cannot answer this | Check whether staging survives and copy can restart after a partial app overwrite |
| Image is valid but cannot boot | CRC/FNV will not detect wrong pins, broken Wi-Fi or application hangs | A verified trial/rollback or separate rescue path; watchdog reset alone is insufficient |
| App boots but camera fails | Separate maintenance task and authenticated return-to-stock interface are implemented | Board provisioning, hardware startup and recovery remain untested |
| Bootloader damaged | Current network candidate is app-only | Preserve bootloader/calibration; UART/SPI recovery may require enclosure access |

The original SD upgrade scanner runs in the main application. It is useful
only if that application still runs far enough to mount and scan the card;
it is not evidence of bootloader-level SD rescue. No evidence currently shows
that this camera's USB port exposes a no-disassembly recovery console.

## Planned migration design, not implemented guarantees

1. Identify and preserve the installed bootloader, its real partition table,
   and device-specific RF/configuration data through a demonstrated read-only
   path. Do not substitute the reference SDK bootloader.
2. Keep network maintenance/provisioning independent of sensor initialization;
   a failed sensor must not disable a working rescue interface.
3. Verify how the installed loader handles interrupted app copying and valid
   but unhealthy images. If it cannot roll back a bad app, an application-only
   upgrade cannot promise recovery from an early crash. A second slot/rescue
   loader would require separate flash-layout and bootloader work.
4. Only after these facts and board bring-up are established, test on a spare
   unit with a known recovery path under separate flashing authorization.

`ota_preflight.py` performs local format/CRC/bounds checks and accepts optional
capacities supplied from independently verified partition evidence. It cannot
prove bootability or recovery and always reports `safe_to_flash: false`.
The CI uses synthetic packages and tests every truncated prefix, each one-byte
corruption, wrong destinations/formats, and capacity overruns. These are parser
tests, not simulated proof of the unknown bootloader's power-loss behavior.

Sources: [pinned SDK](https://github.com/NonPIayerCharacter/beken_freertos_sdk/tree/1af1d4f549039bbecd7d07ffbbb7e24dc0bca57d),
[SDK partition-address documentation](https://github.com/NonPIayerCharacter/beken_freertos_sdk/blob/1af1d4f549039bbecd7d07ffbbb7e24dc0bca57d/beken378/docs/zh_CN/developer-guide/partition_specification/index.rst),
[original application evidence and addresses](BOARD-AND-UPGRADE.md).

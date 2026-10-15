# Local maintenance and returning to stock

[Actions run 38688617223](https://github.com/neqq3/jiumu-camera-bridge/actions/runs/38688617223)
passed both the actual SDK build and host tests for commit `fa7b8a3`. It linked
the real maintenance/Flash implementation, passed 11 HTTP/client integration
checks plus core/adapter fault tests and eight Python checks. Existing synthetic
RTSP tests still decoded two sessions of 12 VGA frames each. The image has
449,864 text bytes, 756 initialized-data bytes and 101,664 BSS bytes; task stacks,
SDK pools and network/frame buffers additionally consume runtime memory.

This is implemented research code, tested without a camera. It is not a release
image or permission to flash an A907-J. The installed bootloader/FAL table and a
working first-migration recovery route have not been obtained. The checked-in
board configuration therefore supplies no credential, listener or write contract.

## Implemented path

`research-app.c` creates a maintenance task separately from, and at higher priority
than, the RTSP task. The maintenance path does not call the sensor driver. It
still requires the SDK, RTOS, flash driver and networking to initialize: an invalid
image, startup crash, broken scheduler or broken network stack can make it
unreachable. This is application maintenance, not an independent rescue loader.

The portable HTTP/core implementation links to the pinned SDK's actual physical
flash driver. It does not invoke the SDK's unauthenticated HTTP downloader.
The network API cannot provide or override the installed-loader trust contract.

| Request | Behavior |
| --- | --- |
| `GET /v1/status` | Authenticated state, transfer counts and reboot readiness; no token or device credentials |
| `GET /v1/backup` | Authenticated physical Flash download, only for a recognized JEDEC/size pair |
| `POST /v1/restore` | Stream a stock-format RBL into the verified download region; leave its header erased |
| `POST /v1/restore/commit` | Require the exact trusted whole-package SHA-256, reverify stored data, then write the 96-byte header last |
| `POST /v1/restore/abort` | Invalidate an incomplete/error/verified transaction; refuse an already committed transaction |
| `POST /v1/reboot` | Separate explicit reboot request, allowed only after commit and if the Flash adapter is healthy |

Every route requires a locally generated 256-bit token supplied as an Authorization
Bearer header. There are no defaults, URL tokens, CORS, cookies, outbound requests,
vendor downloads or HTTP redirects. The server rejects ambiguous Content-Length,
Transfer-Encoding, Origin, duplicate authentication and oversized headers. Header
input expires after three seconds; a transfer has a 90-second total limit and a
three-second inactivity limit. Only one connection runs at a time.

This small server uses HTTP, not TLS. It is not exposed by the research build.
An eventual board port must provision a local secret and networking; LAN HTTP
requires a trusted network, or a separately secured transport. The included client
defaults to loopback and requires an explicit flag for private-LAN plaintext.
Do not expose this interface to the Internet.

## Flash contract and transaction

The SDK adapter rejects the SDK's unknown-chip/default-size fallback. It requires
an exact recognized JEDEC ID/capacity, currently capped at 4 MiB. A board-supplied
contract must additionally match the physical boot/FAL-prefix SHA-256, the actual
chip, application and download bounds, CRC-expanded app capacity and the compiled
SDK map. The download region must not overlap any other SDK partition. The board
port must establish that the hashed installed loader uses these exact FAL bounds
and the supported RBL contract; matching arbitrary hashes is not verification.
No such retail-device contract is supplied in this repository.

The core accepts only `app` RBL packages with the observed `0x402` format, valid
header/body CRCs, correct length and AES block alignment. It reserves the final
96 logical app bytes for installed metadata. An independently provisioned whole
stock-package SHA-256 is mandatory: an uploader cannot authorize its own package.
The implementation preserves the original encrypted package; it does not embed
vendor encryption keys or repack the image.

The sequence is:

1. Validate all 96 metadata bytes and bounds before erasing anything.
2. Erase and verify the staging header before storing body bytes. Do not touch the
   running application, bootloader, calibration or settings partitions.
3. Read back the entire stored body; check CRC and the trusted package hash.
4. Wait for a separate commit request with the exact package digest.
5. Re-read and verify storage, then write and read back the header last.
6. Wait for a separate reboot request. Commit does not restart the device itself.

Each SDK write/erase restores the previous Flash protection mode and checks
readback. Storage/protection faults quarantine further modification and reboot.
An error during the final header write can leave a valid header; the status field
`header_may_be_valid` remains conservative. A pre-existing staged header is also
treated as potentially valid until its invalidation is confirmed. An HTTP error
does not mean that a later physical power cycle cannot install an already
committed image. Underlying SDK controller polling has no timeout; a stuck
controller is not solved by the HTTP deadlines.

## Backup and switching limits

A backup from this interface is a physical Flash dump from a **running custom
application**. It can contain credentials, identifiers, calibration and firmware;
keep it private. It does not solve obtaining the first backup while stock is
installed, and does not restore the pre-migration app bytes after migration.
The client writes an owner-only file where supported, retains failed transfers as
`.partial`, refuses existing destinations and writes a local SHA-256 manifest.
Windows users must also keep the directory under an appropriate user ACL.

Returning to stock uses a locally held, previously validated app-only RBL. It
preserves boot and device-specific regions, but does not automatically restore
server settings or official-account binding. The research branch does not contain
a stock-to-custom packer, a ready-to-flash image or an automatic migration command.

The reference loader erases the staging header before launching a successfully
copied app. It also skips a package whose full 96-byte header equals installed
metadata; resending the same package is not proven to repair damaged app code.
There is no demonstrated old-app slot or health-based rollback. See
[the readout investigation](READOUT-AND-SWITCHING.md) and
[special modes](SPECIAL-MODES-AND-RECOVERY.md).

## Application-image identity

The SDK links both `bk7252n.elf` at zero and `bk7231_bsp.elf` at `0x10000`.
Only the latter is the preserved-loader application candidate. The SDK initially
generates raw BSP bytes, preserves them as `bsp.bin`, then replaces the similarly
named `bk7231_bsp.bin` with CRC-encoded bytes. QIO combines bootloader and app.
Neither filename similarity nor a successful ELF link makes these interchangeable.

`check_layout.py` verifies both ELF/map origins, the BSP reset branch, a fresh
objcopy comparison against raw `bsp.bin`, and the reference app budget minus
96 bytes of metadata. Its report always keeps `safe_to_flash: false`; reference
layout agreement is not identification of this camera's installed bootloader.
The workflow publishes only the report and symbols, never these binary files.

## Development use and tests

`maintenance_client.py` provides separate `new-token`, `status`, `backup`, `stage`,
`commit`, `abort` and `reboot` commands. It reads the token from a local file, never
prints it, validates peer response values against known enums and refuses public
addresses. Invoke `--help` for syntax. It only targets this custom maintenance API;
it cannot operate the stock camera. No command is run against household hardware
by the workflow.

GitHub Actions runs the production C parser/core with ASan/UBSan using synthetic
RBLs and file-backed Flash. Core tests cover every truncated prefix, every body
byte corruption, a CRC-valid untrusted package, readback corruption after
verification, storage-operation errors, torn commit headers and partial erases.
HTTP tests cover authentication, framing, disconnect/restart, explicit commit,
backup integrity/no-overwrite, client behavior and quarantined reboot.

The same SDK adapter also runs against an explicitly fake host driver to exercise
JEDEC/map/hash rejection and protection restoration. This is a driver-contract
test, not a physical Flash or bootloader simulator. A separate Actions job links
the real SDK implementations and checks their symbols. Neither job establishes
physical power-loss recovery, early-crash recovery, sensor output or runtime
memory headroom. Only text evidence is published; no firmware or backup is uploaded.

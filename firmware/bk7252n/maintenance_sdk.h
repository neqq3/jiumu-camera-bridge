/* SPDX-License-Identifier: Apache-2.0 */
#ifndef JIUMU_MAINTENANCE_SDK_H
#define JIUMU_MAINTENANCE_SDK_H
#include "maintenance_core.h"

/* This is a board-port input established OUTSIDE the network API, from a
 * verified backup of the installed loader/table and its OTA contract. Merely
 * copying the reference SDK's partition constants is not verification. */
typedef struct {
    uint32_t version;
    uint32_t jedec_id;
    uint32_t flash_bytes;
    uint32_t boot_prefix_bytes; /* Physical bytes, including CRC and FAL table. */
    uint8_t boot_prefix_sha256[32];
    uint32_t app_physical_offset;
    uint32_t app_physical_bytes;
    uint32_t app_logical_bytes;
    uint32_t staging_offset;
    uint32_t staging_bytes;
    uint8_t trusted_stock_sha256[32];
} maintenance_boot_contract;

typedef struct {
    mc_context restore;
    maintenance_boot_contract contract;
    uint32_t jedec_id;
    uint32_t flash_bytes;
    int flash_recognized;
    int contract_verified;
    int quarantined;
    const char *reason;
} maintenance_sdk_context;

/* No flash write, Wi-Fi change, reboot or listener is performed by probe.
 * A recognized JEDEC ID is required; the SDK's unknown-chip size is rejected. */
int maintenance_sdk_probe(maintenance_sdk_context *ctx);
int maintenance_sdk_accept_contract(maintenance_sdk_context *ctx,
                                    const maintenance_boot_contract *contract);
/* Only expose this callback behind authentication. A full physical dump may
 * contain credentials, identifiers and calibration; never log its contents.
 * This is a post-install backup facility, not a stock migration bypass. */
int maintenance_sdk_backup_read(void *ctx, uint32_t offset,
                                uint8_t *data, size_t size);
int maintenance_sdk_reboot_ready(void *ctx);
void maintenance_sdk_reboot(void *ctx);

typedef struct {
    const char *bind_address;
    unsigned port;
    const char *bearer_token;
    const maintenance_boot_contract *contract; /* NULL allows authenticated backup only. */
} maintenance_start_config;

/* Board integration supplies config in RAM; this never guesses a free NVS
 * sector or reuses original RF/NET credentials. The checked-in weak provider
 * returns NULL: no default credential, listener, Wi-Fi setup or flash writes.
 * Configuration must remain alive until the server returns. */
const maintenance_start_config *maintenance_board_config(void);
int maintenance_sdk_serve(const maintenance_start_config *config);
void maintenance_sdk_task(void *arg);
#endif

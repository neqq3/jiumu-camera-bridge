/* SPDX-License-Identifier: Apache-2.0 */
#ifndef JIUMU_MAINTENANCE_CORE_H
#define JIUMU_MAINTENANCE_CORE_H
#include <stddef.h>
#include <stdint.h>

#define MC_HEADER_SIZE 96u
#define MC_MAX_PACKAGE (4u * 1024u * 1024u)
#define MC_SHA256_SIZE 32u

typedef enum {
    MC_DISABLED, MC_IDLE, MC_RECEIVING, MC_VERIFIED, MC_COMMITTED, MC_ERROR
} mc_state;
typedef enum {
    MC_OK = 0, MC_ERR_DISABLED = -1, MC_ERR_ARGUMENT = -2,
    MC_ERR_STATE = -3, MC_ERR_FORMAT = -4, MC_ERR_BOUNDS = -5,
    MC_ERR_IO = -6, MC_ERR_INTEGRITY = -7, MC_ERR_INCOMPLETE = -8
} mc_result;

/* Operations address ONLY the independently verified download partition.
 * read/write must support byte-granular offsets and lengths; success is 0.
 * erase is aligned to erase_size. The implementation never addresses app,
 * bootloader, credentials or calibration. Caller serializes every operation. */
typedef struct {
    void *user;
    int (*read)(void *user, uint32_t offset, void *data, size_t size);
    int (*erase)(void *user, uint32_t offset, size_t size);
    int (*write)(void *user, uint32_t offset, const void *data, size_t size);
    uint32_t erase_size;
} mc_backend;

/* Installed-loader/FAL evidence is an initialization prerequisite, NEVER an
 * HTTP option. The hash is the whole user-owned stock RBL, not an upload hash
 * chosen by the client. No image, key or retail-unit identifier is embedded. */
typedef struct {
    int verified_boot_contract;
    uint32_t app_capacity;
    uint32_t staging_capacity;
    uint8_t trusted_stock_sha256[MC_SHA256_SIZE];
} mc_policy;

typedef struct {
    mc_backend backend;
    mc_policy policy;
    mc_state state;
    mc_result last_error;
    uint32_t total_bytes;
    uint32_t received_bytes;
    uint8_t header[MC_HEADER_SIZE];
    int staging_invalidated;
    /* Initially 1: old staging contents are unknown until invalidated/read.
     * Set before invalidating an older marker and before the commit write.
     * On an I/O error a header could be valid: ERROR does not promise that
     * reboot cannot install an image. */
    int header_may_be_valid;
} mc_context;

mc_result mc_init(mc_context *ctx, const mc_backend *backend, const mc_policy *policy);
mc_result mc_begin(mc_context *ctx, uint32_t total_bytes);
mc_result mc_feed(mc_context *ctx, const uint8_t *data, size_t size);
mc_result mc_finish(mc_context *ctx);
mc_result mc_commit(mc_context *ctx);
/* Discards an incomplete/error/verified upload; refuses COMMITTED. */
mc_result mc_abort(mc_context *ctx);
const char *mc_state_name(mc_state state);
const char *mc_error_name(mc_result result);
void mc_sha256(const void *data, size_t size, uint8_t out[MC_SHA256_SIZE]);
/* Bounded-memory hashing for an independently bounded read-only region. */
mc_result mc_sha256_read(int (*read)(void *,uint32_t,void *,size_t), void *user,
                        uint32_t offset, uint32_t size, uint8_t out[MC_SHA256_SIZE]);
uint32_t mc_crc32(const void *data, size_t size);
#endif

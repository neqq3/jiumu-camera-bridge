/* SPDX-License-Identifier: Apache-2.0 */
#ifndef JIUMU_MAINTENANCE_HTTP_H
#define JIUMU_MAINTENANCE_HTTP_H
#include "maintenance_core.h"
typedef struct {
    mc_context *restore;
    /* Exactly 64 lower-case hex characters, generated/provisioned locally.
     * Never printed, accepted in URLs, persisted by this server or defaulted. */
    const char *token;
    void *device;
    uint32_t backup_bytes;
    int (*backup_read)(void *device, uint32_t offset, uint8_t *data, size_t size);
    int (*reboot_ready)(void *device);
    void (*reboot)(void *device);
} mh_server_config;

/* Caller owns config/token/context for the whole lifetime; one serialized
 * connection, no outgoing network traffic. Platform must provision networking.
 * Plain HTTP: production LAN exposure/TLS is NOT enabled by the research app. */
int maintenance_http_serve(const char *bind_ip, unsigned port, const mh_server_config *config);
#endif

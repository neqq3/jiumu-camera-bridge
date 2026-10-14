/* SPDX-License-Identifier: Apache-2.0 */
#ifndef RESEARCH_RTSP_SERVER_H
#define RESEARCH_RTSP_SERVER_H
#include <stddef.h>
#include <stdint.h>
/* Return byte count or zero if no fresh frame; never return a stale frame. */
typedef size_t (*rtsp_frame_fn)(void *, uint8_t *, size_t);
int research_rtsp_serve(const char *bind_ip, unsigned port, rtsp_frame_fn frame, void *ctx);
#endif

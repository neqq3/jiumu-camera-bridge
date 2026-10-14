/* SPDX-License-Identifier: Apache-2.0 */
#ifndef RESEARCH_RTP_JPEG_H
#define RESEARCH_RTP_JPEG_H
#include <stddef.h>
#include <stdint.h>
#define JPEG_FRAME_LIMIT 65536u
typedef struct {
    const uint8_t *scan;
    size_t length;
    uint8_t quant[128], width8, height8, type;
} jpeg_view;
typedef int (*rtp_write_fn)(void *, const uint8_t *, size_t);
int jpeg_parse(const uint8_t *data, size_t length, jpeg_view *out);
int rtp_jpeg_send(const jpeg_view *view, uint32_t timestamp, uint32_t ssrc,
                  uint16_t *sequence, uint8_t channel, rtp_write_fn write, void *ctx);
#endif

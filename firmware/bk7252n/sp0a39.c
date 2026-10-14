/* SPDX-License-Identifier: Apache-2.0 */
#include "sp0a39.h"
#include <stddef.h>
typedef struct { uint8_t reg, val; } sp0a39_reginfo_t;
#include "third_party/sp0a39-dvp-gray.h"

/* Candidate color delta, NOT a hardware-validated profile. See SENSOR.md.
 * No guessed RESET/PWDN GPIO and no whole proprietary register table. */
static const sp0a39_reginfo_t color_candidate[] = {
    {0xfd, 0x00}, {0x31, 0x00}, {0x32, 0x02},
    {0xfd, 0x01}, {0x32, 0x15}, {0x35, 0x10},
    {0xfd, 0x02}, {0x26, 0xcb}, {0x27, 0xc2}, {0xfd, 0x00}
};

int sp0a39_init_candidate(sp0a39_read_fn rd, sp0a39_write_fn wr)
{
    uint8_t hi = 0, lo = 0;
    size_t i;
    if (!rd || !wr) return -1;
    /* Page selection is the only write before successful chip identification. */
    if (wr(0xfd, 0) || rd(0x00, &hi) || rd(0x01, &lo)) return -2;
    if (hi != 0x0a || lo != 0x39) return -3;
    for (i = 0; i < sizeof(DVP_8bit_24Minput_Gray_640x480_30fps) / sizeof(sp0a39_reginfo_t); ++i) {
        const sp0a39_reginfo_t *r = &DVP_8bit_24Minput_Gray_640x480_30fps[i];
        if (wr(r->reg, r->val)) return -4;
    }
    for (i = 0; i < sizeof(color_candidate) / sizeof(color_candidate[0]); ++i)
        if (wr(color_candidate[i].reg, color_candidate[i].val)) return -4;
    return 0;
}

/* SPDX-License-Identifier: Apache-2.0 */
#ifndef RESEARCH_SP0A39_H
#define RESEARCH_SP0A39_H
#include <stdint.h>
#define SP0A39_ADDRESS 0x21
/* Callbacks return zero on success, nonzero on bus failure. */
typedef int (*sp0a39_read_fn)(uint8_t, uint8_t *);
typedef int (*sp0a39_write_fn)(uint8_t, uint8_t);
int sp0a39_init_candidate(sp0a39_read_fn read_reg, sp0a39_write_fn write_reg);
#endif

/* SPDX-License-Identifier: Apache-2.0
 * Explicit host-only fake driver: these tests exercise adapter invariants,
 * not the physical flash, protection register, bootloader or recovery. */
#ifndef JIUMU_SDK_TEST_API_H
#define JIUMU_SDK_TEST_API_H
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
typedef uint32_t UINT32;
#define FLASH_SUCCESS 0u
#define FLASH_FAILURE 1u
enum { CMD_FLASH_GET_ID=1,CMD_FLASH_GET_SIZE,CMD_FLASH_GET_PROTECT,
       CMD_FLASH_SET_PROTECT,CMD_FLASH_ERASE_SECTOR };
typedef enum { FLASH_PROTECT_NONE,FLASH_PROTECT_ALL,FLASH_PROTECT_HALF,
               FLASH_UNPROTECT_LAST_BLOCK } PROTECT_TYPE;
typedef enum { BK_PARTITION_BOOTLOADER,BK_PARTITION_APPLICATION,BK_PARTITION_OTA,
               BK_PARTITION_RF_FIRMWARE,BK_PARTITION_NET_PARAM,BK_PARTITION_MAX } bk_partition_t;
enum { BK_FLASH_EMBEDDED };
typedef struct {
    unsigned partition_owner;
    const char *partition_description;
    uint32_t partition_start_addr,partition_length,partition_options;
} bk_logic_partition_t;
#define GLOBAL_INT_DECLARATION()
#define GLOBAL_INT_DISABLE() ((void)0)
#define GLOBAL_INT_RESTORE() ((void)0)
#define os_printf printf
UINT32 flash_ctrl(UINT32 cmd,void *arg);
UINT32 flash_read(char *out,UINT32 size,UINT32 address);
UINT32 flash_write(char *in,UINT32 size,UINT32 address);
bk_logic_partition_t *bk_flash_get_info(bk_partition_t partition);
int rtos_delay_milliseconds(uint32_t delay);
int rtos_delete_thread(void *thread);
void bk_reboot(void);
#endif

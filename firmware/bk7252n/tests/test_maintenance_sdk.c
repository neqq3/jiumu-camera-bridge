/* SPDX-License-Identifier: Apache-2.0 */
#include "sdk_test_api.h"
#include "maintenance_sdk.h"
#include "maintenance_http.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

#define BYTES 0x200000u
#define STAGE 0x132000u
#define STAGE_SIZE 0xae000u
static uint8_t flash_bytes[BYTES];
static uint32_t identity,capacity,protection;
static unsigned writes,erases,reads,reboots,locks;
static int ignore_write,ignore_unprotect,ignore_restore,inconsistent_read;
static bk_logic_partition_t partitions[BK_PARTITION_MAX];

int hal_flash_lock(void) { assert(!locks); ++locks; return 0; }
int hal_flash_unlock(void) { assert(locks==1); --locks; return 0; }
int rtos_delay_milliseconds(uint32_t delay) { (void)delay; return 0; }
int rtos_delete_thread(void *thread) { (void)thread; return 0; }
void bk_reboot(void) { ++reboots; }
int maintenance_http_serve(const char *bind_ip,unsigned port,const mh_server_config *config)
{ (void)bind_ip; (void)port; (void)config; return -1; }
bk_logic_partition_t *bk_flash_get_info(bk_partition_t partition)
{ assert(partition<BK_PARTITION_MAX); return &partitions[partition]; }
UINT32 flash_read(char *out,UINT32 size,UINT32 address)
{
    assert(locks==1 && size && address<=BYTES && size<=BYTES-address);
    memcpy(out,flash_bytes+address,size); ++reads;
    if (inconsistent_read && reads%2) out[0]^=1;
    return FLASH_SUCCESS;
}
UINT32 flash_write(char *in,UINT32 size,UINT32 address)
{
    unsigned i;
    assert(locks==1 && protection==FLASH_PROTECT_NONE);
    assert(address>=STAGE && address<=STAGE+STAGE_SIZE && size<=STAGE+STAGE_SIZE-address);
    ++writes;
    if (!ignore_write) for (i=0;i<size;++i) flash_bytes[address+i]&=(uint8_t)in[i];
    return FLASH_SUCCESS; /* Like pinned SDK, may report success without proof. */
}
UINT32 flash_ctrl(UINT32 cmd,void *arg)
{
    UINT32 *value=arg;
    assert(locks==1);
    switch(cmd) {
        case CMD_FLASH_GET_ID: *value=identity; break;
        case CMD_FLASH_GET_SIZE: *value=capacity; break;
        case CMD_FLASH_GET_PROTECT: *value=protection; break;
        case CMD_FLASH_SET_PROTECT:
            if ((*value==FLASH_PROTECT_NONE && !ignore_unprotect) ||
                (*value!=FLASH_PROTECT_NONE && !ignore_restore)) protection=*value;
            break;
        case CMD_FLASH_ERASE_SECTOR:
            assert(protection==FLASH_PROTECT_NONE && *value%4096==0);
            assert(*value>=STAGE && *value<=STAGE+STAGE_SIZE-4096);
            memset(flash_bytes+*value,0xff,4096); ++erases; break;
        default: return FLASH_FAILURE;
    }
    return FLASH_SUCCESS;
}
static void reset(void)
{
    memset(flash_bytes,0x53,sizeof(flash_bytes));
    memset(partitions,0,sizeof(partitions));
    identity=0xc84015; capacity=BYTES; protection=FLASH_PROTECT_HALF;
    writes=erases=reads=reboots=locks=0;
    ignore_write=ignore_unprotect=ignore_restore=inconsistent_read=0;
    partitions[BK_PARTITION_BOOTLOADER].partition_length=0xf000;
    partitions[BK_PARTITION_APPLICATION].partition_start_addr=0x11000;
    partitions[BK_PARTITION_APPLICATION].partition_length=0x121000;
    partitions[BK_PARTITION_OTA].partition_start_addr=STAGE;
    partitions[BK_PARTITION_OTA].partition_length=STAGE_SIZE;
    partitions[BK_PARTITION_RF_FIRMWARE].partition_start_addr=0x1e0000;
    partitions[BK_PARTITION_RF_FIRMWARE].partition_length=4096;
    partitions[BK_PARTITION_NET_PARAM].partition_start_addr=0x1e1000;
    partitions[BK_PARTITION_NET_PARAM].partition_length=4096;
}
static maintenance_boot_contract contract(void)
{
    maintenance_boot_contract c;
    memset(&c,0,sizeof(c)); c.version=1; c.jedec_id=identity;c.flash_bytes=BYTES;
    c.boot_prefix_bytes=0x11000;c.app_physical_offset=0x11000;
    c.app_physical_bytes=0x121000;c.app_logical_bytes=0x110000;
    c.staging_offset=STAGE;c.staging_bytes=STAGE_SIZE;
    mc_sha256(flash_bytes,c.boot_prefix_bytes,c.boot_prefix_sha256);
    memset(c.trusted_stock_sha256,0x82,32);
    return c;
}
static maintenance_sdk_context prepared(void)
{
    maintenance_sdk_context c;
    maintenance_boot_contract b=contract();
    assert(maintenance_sdk_probe(&c)==0);
    assert(maintenance_sdk_accept_contract(&c,&b)==0);
    assert(c.contract_verified && c.restore.state==MC_IDLE);
    return c;
}
/* Struct copies change callback user pointers; repair after returning fixture. */
static void fix(maintenance_sdk_context *ctx) { ctx->restore.backend.user=ctx; }

int main(void)
{
    maintenance_sdk_context ctx;
    maintenance_boot_contract c;
    uint8_t data[400],out[400];
    reset(); identity=0; assert(maintenance_sdk_probe(&ctx)!=0);
    assert(!ctx.flash_recognized && ctx.restore.state==MC_DISABLED);
    assert(maintenance_sdk_backup_read(&ctx,0,out,32)!=0);
    reset();capacity=0x400000; assert(maintenance_sdk_probe(&ctx)!=0);
    reset();capacity=0x800000; assert(maintenance_sdk_probe(&ctx)!=0);
    reset();assert(maintenance_sdk_probe(&ctx)==0);
    assert(maintenance_sdk_backup_read(&ctx,UINT32_MAX,out,32)!=0);
    assert(maintenance_sdk_backup_read(&ctx,BYTES-16,out,32)!=0);
    assert(ctx.restore.backend.erase(&ctx,0,4096)!=0);
    assert(writes==0 && erases==0);

    c=contract();c.boot_prefix_sha256[0]^=1;
    assert(maintenance_sdk_accept_contract(&ctx,&c)!=0 && writes==0 && erases==0);
    c=contract();partitions[BK_PARTITION_RF_FIRMWARE].partition_start_addr=STAGE;
    assert(maintenance_sdk_accept_contract(&ctx,&c)!=0);
    reset();assert(maintenance_sdk_probe(&ctx)==0);c=contract();c.app_logical_bytes=0x120000;
    assert(maintenance_sdk_accept_contract(&ctx,&c)!=0);

    reset();ctx=prepared();fix(&ctx);
    assert(ctx.restore.backend.erase(&ctx,1,4096)!=0);
    assert(ctx.restore.backend.write(&ctx,STAGE_SIZE-16,data,32)!=0);
    assert(writes==0 && erases==0);
    assert(ctx.restore.backend.erase(&ctx,0,4096)==0);
    assert(protection==FLASH_PROTECT_HALF && erases==1);
    memset(data,0x25,sizeof(data));
    assert(ctx.restore.backend.write(&ctx,96,data,sizeof(data))==0);
    assert(protection==FLASH_PROTECT_HALF && writes==2);
    assert(ctx.restore.backend.read(&ctx,96,out,sizeof(out))==0 && !memcmp(data,out,sizeof(data)));
    assert(flash_bytes[STAGE-1]==0x53 && flash_bytes[STAGE+STAGE_SIZE]==0x53);
    maintenance_sdk_reboot(&ctx);assert(reboots==0);

    reset();ctx=prepared();fix(&ctx);assert(ctx.restore.backend.erase(&ctx,0,4096)==0);
    ignore_write=1;
    assert(ctx.restore.backend.write(&ctx,96,data,sizeof(data))!=0 && ctx.quarantined);
    assert(protection==FLASH_PROTECT_HALF);
    ctx.restore.state=MC_COMMITTED;assert(!maintenance_sdk_reboot_ready(&ctx));
    maintenance_sdk_reboot(&ctx);assert(reboots==0);
    assert(ctx.restore.backend.erase(&ctx,0,4096)!=0);

    reset();ctx=prepared();fix(&ctx);ignore_unprotect=1;
    assert(ctx.restore.backend.erase(&ctx,0,4096)!=0 && ctx.quarantined && erases==0);
    assert(protection==FLASH_PROTECT_HALF);
    reset();ctx=prepared();fix(&ctx);ignore_restore=1;
    assert(ctx.restore.backend.erase(&ctx,0,4096)!=0 && ctx.quarantined);
    assert(protection==FLASH_PROTECT_NONE); /* Error must never pretend restored. */
    reset();assert(maintenance_sdk_probe(&ctx)==0);inconsistent_read=1;
    assert(maintenance_sdk_backup_read(&ctx,0,out,32)!=0 && ctx.quarantined);
    assert(writes==0 && erases==0);
    reset();ctx=prepared();fix(&ctx);ctx.restore.state=MC_COMMITTED;
    assert(maintenance_sdk_reboot_ready(&ctx));
    maintenance_sdk_reboot(&ctx);assert(reboots==1);
    assert(maintenance_board_config()==NULL);
    assert(!locks);
    puts("SDK adapter fake-driver tests passed: identity, contracts, bounds, readback, protection restoration, quarantine; no hardware or boot recovery exercised.");
    return 0;
}

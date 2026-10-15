/* SPDX-License-Identifier: Apache-2.0 */
#include "include.h"
#include "rtos_pub.h"
#include "uart_pub.h"
#include "flash_pub.h"
#include "BkDriverFlash.h"
#include "wlan_ui_pub.h"
#include "maintenance_sdk.h"
#include "maintenance_http.h"
#include "maintenance_flash_chips.h" /* Generated from the pinned SDK. */
#include <string.h>

extern int hal_flash_lock(void);
extern int hal_flash_unlock(void);
#define MS_SECTOR 4096u
#define MS_CHUNK 256u

static int inside(uint32_t offset, size_t size, uint32_t capacity)
{
    return size && offset <= capacity && size <= capacity - offset;
}
static int overlaps(uint32_t a, uint32_t as, uint32_t b, uint32_t bs)
{
    return as && bs && a < b + bs && b < a + as;
}
static int nonzero_hash(const uint8_t hash[32])
{
    unsigned i, value=0;
    for (i=0; i<32; ++i) value |= hash[i];
    return value != 0;
}
static int quarantine(maintenance_sdk_context *ctx, const char *reason)
{
    ctx->quarantined=1;
    ctx->reason=reason;
    return -1;
}

/* Use the real driver's physical read path. Both the SDK partition wrappers
 * and low-level read return success unconditionally, so callers hash/check
 * readback; these return codes alone are not evidence of correct media. */
int maintenance_sdk_backup_read(void *opaque, uint32_t offset,
                                uint8_t *data, size_t size)
{
    maintenance_sdk_context *ctx=opaque;
    uint8_t again[MS_CHUNK];
    size_t count;
    UINT32 first, second;
    GLOBAL_INT_DECLARATION();
    if (!ctx || !ctx->flash_recognized || !data ||
        !inside(offset,size,ctx->flash_bytes)) return -1;
    if (hal_flash_lock()!=0) return -1;
    while (size) {
        count=size>MS_CHUNK ? MS_CHUNK : size;
        GLOBAL_INT_DISABLE();
        first=flash_read((char *)data,(UINT32)count,offset);
        second=flash_read((char *)again,(UINT32)count,offset);
        GLOBAL_INT_RESTORE();
        if (first!=FLASH_SUCCESS || second!=FLASH_SUCCESS ||
            memcmp(data,again,count)!=0) {
            hal_flash_unlock();
            return quarantine(ctx,"flash readback mismatch");
        }
        offset+=(uint32_t)count; data+=count; size-=count;
    }
    hal_flash_unlock();
    return 0;
}

static int stage_range(maintenance_sdk_context *ctx,uint32_t offset,size_t size)
{
    return ctx && ctx->contract_verified && !ctx->quarantined &&
        inside(offset,size,ctx->contract.staging_bytes);
}
static int stage_read(void *opaque,uint32_t offset,void *data,size_t size)
{
    maintenance_sdk_context *ctx=opaque;
    if (!stage_range(ctx,offset,size)) return -1;
    return maintenance_sdk_backup_read(ctx,ctx->contract.staging_offset+offset,data,size);
}
static int physical_hash_read(void *opaque,uint32_t offset,void *data,size_t size)
{
    return maintenance_sdk_backup_read(opaque,offset,data,size);
}

/* Flash protection is restored after EACH short operation, including errors.
 * No image verification, HTTP blocking or long erase loop occurs while global
 * protection is disabled. SDK calls internally poll hardware with no timeout;
 * host fault injection cannot prove recovery from a stuck flash controller. */
static int modify(maintenance_sdk_context *ctx,uint32_t address,
                  const uint8_t *data,size_t size,int erase)
{
    UINT32 saved=0, observed=0, none=FLASH_PROTECT_NONE, result, restored;
    GLOBAL_INT_DECLARATION();
    if (hal_flash_lock()!=0) return -1;
    GLOBAL_INT_DISABLE();
    result=flash_ctrl(CMD_FLASH_GET_PROTECT,&saved);
    if (result!=FLASH_SUCCESS || saved>FLASH_UNPROTECT_LAST_BLOCK) {
        GLOBAL_INT_RESTORE(); hal_flash_unlock();
        return quarantine(ctx,"cannot read flash protection");
    }
    result=flash_ctrl(CMD_FLASH_SET_PROTECT,&none);
    if (flash_ctrl(CMD_FLASH_GET_PROTECT,&observed)!=FLASH_SUCCESS || observed!=none)
        result=FLASH_FAILURE;
    if (result==FLASH_SUCCESS) {
        if (erase) result=flash_ctrl(CMD_FLASH_ERASE_SECTOR,&address);
        else result=flash_write((char *)data,(UINT32)size,address);
    }
    restored=flash_ctrl(CMD_FLASH_SET_PROTECT,&saved);
    if (flash_ctrl(CMD_FLASH_GET_PROTECT,&observed)!=FLASH_SUCCESS || observed!=saved)
        restored=FLASH_FAILURE;
    GLOBAL_INT_RESTORE();
    hal_flash_unlock();
    if (restored!=FLASH_SUCCESS) return quarantine(ctx,"flash protection restore failed");
    return result==FLASH_SUCCESS ? 0 : quarantine(ctx,"flash operation failed");
}
static int stage_write(void *opaque,uint32_t offset,const void *data,size_t size)
{
    maintenance_sdk_context *ctx=opaque;
    const uint8_t *input=data;
    uint8_t readback[MS_CHUNK];
    size_t count;
    if (!stage_range(ctx,offset,size) || !data) return -1;
    while (size) {
        count=size>MS_CHUNK ? MS_CHUNK : size;
        if (modify(ctx,ctx->contract.staging_offset+offset,input,count,0)!=0 ||
            stage_read(ctx,offset,readback,count)!=0 || memcmp(input,readback,count)!=0)
            return quarantine(ctx,"staging write/readback failed");
        offset+=(uint32_t)count; input+=count; size-=count;
    }
    return 0;
}
static int stage_erase(void *opaque,uint32_t offset,size_t size)
{
    maintenance_sdk_context *ctx=opaque;
    uint8_t readback[MS_CHUNK];
    uint32_t p;
    unsigned i;
    if (!stage_range(ctx,offset,size) || offset%MS_SECTOR || size%MS_SECTOR) return -1;
    while (size) {
        if (modify(ctx,ctx->contract.staging_offset+offset,NULL,MS_SECTOR,1)!=0) return -1;
        for (p=0;p<MS_SECTOR;p+=MS_CHUNK) {
            if (stage_read(ctx,offset+p,readback,sizeof(readback))!=0) return -1;
            for (i=0;i<sizeof(readback);++i)
                if (readback[i]!=0xff) return quarantine(ctx,"staging erase/readback failed");
        }
        offset+=MS_SECTOR; size-=MS_SECTOR;
    }
    return 0;
}

int maintenance_sdk_probe(maintenance_sdk_context *ctx)
{
    UINT32 id=0, bytes=0, id_status, size_status;
    size_t i;
    mc_backend backend;
    mc_policy policy;
    GLOBAL_INT_DECLARATION();
    if (!ctx) return -1;
    memset(ctx,0,sizeof(*ctx));
    memset(&backend,0,sizeof(backend)); memset(&policy,0,sizeof(policy));
    backend.user=ctx; backend.read=stage_read; backend.erase=stage_erase;
    backend.write=stage_write; backend.erase_size=MS_SECTOR;
    (void)mc_init(&ctx->restore,&backend,&policy);
    ctx->reason="flash identity not established";
    if (hal_flash_lock()!=0) return -1;
    GLOBAL_INT_DISABLE();
    id_status=flash_ctrl(CMD_FLASH_GET_ID,&id);
    size_status=flash_ctrl(CMD_FLASH_GET_SIZE,&bytes);
    GLOBAL_INT_RESTORE(); hal_flash_unlock();
    ctx->jedec_id=id;
    if (id_status!=FLASH_SUCCESS || size_status!=FLASH_SUCCESS) return -1;
    if (bytes>MC_MAX_PACKAGE) {
        ctx->reason="flash capacity exceeds bounded maintenance backup support";
        return -1;
    }
    for (i=0;i<sizeof(maintenance_known_chips)/sizeof(maintenance_known_chips[0]);++i)
        if (maintenance_known_chips[i].id==id && maintenance_known_chips[i].bytes==bytes) {
            ctx->flash_bytes=bytes; ctx->flash_recognized=1;
            ctx->reason="read-only: no verified installed boot contract";
            return 0;
        }
    ctx->reason="unknown JEDEC chip or SDK capacity mismatch";
    return -1;
}

int maintenance_sdk_accept_contract(maintenance_sdk_context *ctx,
                                    const maintenance_boot_contract *contract)
{
    const bk_logic_partition_t *part,*app,*stage;
    uint8_t digest[32];
    mc_policy policy;
    uint32_t physical_needed;
    unsigned i;
    if (!ctx || !contract || !ctx->flash_recognized || ctx->quarantined ||
        ctx->contract_verified || contract->version!=1 ||
        contract->jedec_id!=ctx->jedec_id || contract->flash_bytes!=ctx->flash_bytes ||
        !nonzero_hash(contract->boot_prefix_sha256) ||
        !nonzero_hash(contract->trusted_stock_sha256)) return -1;
    app=bk_flash_get_info(BK_PARTITION_APPLICATION);
    stage=bk_flash_get_info(BK_PARTITION_OTA);
    if (!app || !stage || app->partition_owner!=BK_FLASH_EMBEDDED ||
        stage->partition_owner!=BK_FLASH_EMBEDDED ||
        app->partition_start_addr!=contract->app_physical_offset ||
        app->partition_length!=contract->app_physical_bytes ||
        stage->partition_start_addr!=contract->staging_offset ||
        stage->partition_length!=contract->staging_bytes ||
        contract->boot_prefix_bytes!=contract->app_physical_offset ||
        !inside(0,contract->boot_prefix_bytes,256u*1024u) ||
        !inside(contract->app_physical_offset,contract->app_physical_bytes,ctx->flash_bytes) ||
        !inside(contract->staging_offset,contract->staging_bytes,ctx->flash_bytes) ||
        !contract->app_logical_bytes || contract->app_logical_bytes>MC_MAX_PACKAGE ||
        contract->staging_offset%MS_SECTOR || contract->staging_bytes%MS_SECTOR)
        return -1;
    physical_needed=((contract->app_logical_bytes+31u)/32u)*34u;
    if (physical_needed>contract->app_physical_bytes ||
        overlaps(0,contract->boot_prefix_bytes,contract->staging_offset,contract->staging_bytes))
        return -1;
    for (i=0;i<BK_PARTITION_MAX;++i) {
        if (i==BK_PARTITION_OTA) continue;
        part=bk_flash_get_info((bk_partition_t)i);
        if (part && part->partition_length) {
            if (!inside(part->partition_start_addr,part->partition_length,ctx->flash_bytes) ||
                overlaps(part->partition_start_addr,part->partition_length,
                         contract->staging_offset,contract->staging_bytes)) return -1;
        }
    }
    if (mc_sha256_read(physical_hash_read,ctx,0,
                      contract->boot_prefix_bytes,digest)!=MC_OK ||
        memcmp(digest,contract->boot_prefix_sha256,sizeof(digest))!=0) {
        ctx->reason="installed boot/table hash does not match contract";
        return -1;
    }
    ctx->contract=*contract;
    memset(&policy,0,sizeof(policy));
    policy.verified_boot_contract=1;
    policy.app_capacity=contract->app_logical_bytes;
    policy.staging_capacity=contract->staging_bytes;
    memcpy(policy.trusted_stock_sha256,contract->trusted_stock_sha256,32);
    /* mc_init copies the backend, so avoid an alias to its zeroed context. */
    {
        mc_backend backend=ctx->restore.backend;
        if (mc_init(&ctx->restore,&backend,&policy)!=MC_OK) return -1;
    }
    ctx->contract_verified=1;
    ctx->reason="verified contract; local authenticated maintenance available";
    return 0;
}

int maintenance_sdk_reboot_ready(void *opaque)
{
    maintenance_sdk_context *ctx=opaque;
    return ctx && ctx->contract_verified && !ctx->quarantined &&
        ctx->restore.state==MC_COMMITTED;
}
void maintenance_sdk_reboot(void *opaque)
{
    if (!maintenance_sdk_reboot_ready(opaque)) return;
    rtos_delay_milliseconds(250);
    bk_reboot();
}
const maintenance_start_config *__attribute__((weak)) maintenance_board_config(void)
{
    return NULL;
}
int maintenance_sdk_serve(const maintenance_start_config *config)
{
    maintenance_sdk_context ctx;
    mh_server_config http;
    if (!config || !config->bind_address || !config->bearer_token) return -1;
    (void)maintenance_sdk_probe(&ctx);
    if (config->contract && maintenance_sdk_accept_contract(&ctx,config->contract)!=0)
        os_printf("maintenance: contract rejected; writes remain disabled\r\n");
    memset(&http,0,sizeof(http));
    http.restore=&ctx.restore; http.token=config->bearer_token; http.device=&ctx;
    http.backup_bytes=ctx.flash_recognized ? ctx.flash_bytes : 0;
    http.backup_read=maintenance_sdk_backup_read; http.reboot=maintenance_sdk_reboot;
    http.reboot_ready=maintenance_sdk_reboot_ready;
    return maintenance_http_serve(config->bind_address,config->port,&http);
}
void maintenance_sdk_task(void *arg)
{
    const maintenance_start_config *config=maintenance_board_config();
    (void)arg;
    if (!config)
        os_printf("maintenance: no locally provisioned token/config; listener disabled\r\n");
    else if (maintenance_sdk_serve(config)!=0)
        os_printf("maintenance: service stopped\r\n");
    rtos_delete_thread(NULL);
}

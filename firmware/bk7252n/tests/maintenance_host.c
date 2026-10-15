/* SPDX-License-Identifier: Apache-2.0 */
/* Synthetic file-backed flash ONLY; never compiled into the SDK image. */
#include "maintenance_http.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>

#define FLASH_SIZE 32768u
#define STAGE_OFFSET 4096u
#define STAGE_SIZE 16384u
typedef struct { uint8_t bytes[FLASH_SIZE]; const char *path; unsigned reboot_count; int quarantined; } test_flash;
static test_flash flash;
static int persist(void)
{
    FILE *f=fopen(flash.path,"wb"); size_t n;
    if (!f) return -1;
    n=fwrite(flash.bytes,1,sizeof(flash.bytes),f);
    return fclose(f) || n!=sizeof(flash.bytes)?-1:0;
}
static int flash_read(void *unused,uint32_t off,void *data,size_t size)
{ (void)unused; if (off>STAGE_SIZE || size>STAGE_SIZE-off) return -1; memcpy(data,flash.bytes+STAGE_OFFSET+off,size); return 0; }
static int flash_erase(void *unused,uint32_t off,size_t size)
{ (void)unused; if (off>STAGE_SIZE || size>STAGE_SIZE-off || off%4096 || size%4096) return -1; memset(flash.bytes+STAGE_OFFSET+off,255,size); return persist(); }
static int flash_write(void *unused,uint32_t off,const void *data,size_t size)
{
    const uint8_t *p=data; size_t i; (void)unused;
    if (off>STAGE_SIZE || size>STAGE_SIZE-off) return -1;
    for (i=0;i<size;i++) if ((flash.bytes[STAGE_OFFSET+off+i]&p[i])!=p[i]) return -1;
    for (i=0;i<size;i++) flash.bytes[STAGE_OFFSET+off+i]&=p[i];
    return persist();
}
static int backup(void *unused,uint32_t off,uint8_t *data,size_t size)
{
    char fault[1024]; FILE *f; (void)unused;
    /* Explicit host-only fault injection, never compiled into the SDK. */
    if (snprintf(fault,sizeof(fault),"%s.fault",flash.path)>=(int)sizeof(fault)) return -1;
    f=fopen(fault,"rb"); if (f) { fclose(f); flash.quarantined=1; return -1; }
    if (off>FLASH_SIZE || size>FLASH_SIZE-off) return -1;
    memcpy(data,flash.bytes+off,size); return 0;
}
static int reboot_ready(void *unused) { (void)unused; return !flash.quarantined; }
static void reboot(void *unused)
{ (void)unused; flash.reboot_count++; puts("synthetic reboot requested"); fflush(stdout); }
int main(int argc,char **argv)
{
    FILE *f; uint8_t package[STAGE_SIZE]; char token[66]; size_t size,n;
    mc_context core; mc_backend backend={NULL,flash_read,flash_erase,flash_write,4096};
    mc_policy policy; mh_server_config config;
    if (argc!=6) return 2;
    f=fopen(argv[1],"rb"); if (!f) return 2;
    size=fread(package,1,sizeof(package),f); fclose(f);
    if (size<MC_HEADER_SIZE || size==sizeof(package)) return 2;
    f=fopen(argv[2],"rb"); if (!f) return 2;
    n=fread(token,1,sizeof(token)-1,f); fclose(f); token[n]=0;
    flash.path=argv[3]; memset(flash.bytes,0x5a,sizeof(flash.bytes));
    f=fopen(flash.path,"rb");
    if (f) { n=fread(flash.bytes,1,sizeof(flash.bytes),f); fclose(f); if (n!=sizeof(flash.bytes)) return 2; }
    else if (persist()) return 2;
    memset(&policy,0,sizeof(policy)); policy.verified_boot_contract=strcmp(argv[5],"disabled")!=0;
    policy.app_capacity=16384; policy.staging_capacity=STAGE_SIZE;
    mc_sha256(package,size,policy.trusted_stock_sha256);
    mc_init(&core,&backend,&policy);
    config.restore=&core; config.token=token; config.device=NULL;
    config.backup_bytes=sizeof(flash.bytes); config.backup_read=backup; config.reboot_ready=reboot_ready; config.reboot=reboot;
    signal(SIGPIPE,SIG_IGN);
    return maintenance_http_serve("127.0.0.1",(unsigned)strtoul(argv[4],NULL,10),&config);
}

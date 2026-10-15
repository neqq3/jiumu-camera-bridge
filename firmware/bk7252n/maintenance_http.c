/* SPDX-License-Identifier: Apache-2.0 */
#include "maintenance_http.h"
#include <stdio.h>
#include <string.h>
#ifdef RESEARCH_HOST
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <time.h>
static uint32_t clock_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint32_t)((uint64_t)t.tv_sec*1000+t.tv_nsec/1000000); }
#else
#include "include.h"
#include "rtos_pub.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
static uint32_t clock_ms(void) { return rtos_get_time(); }
#endif

#define MH_HEADER_LIMIT 2048u
#define MH_HEADER_MS 3000u
#define MH_TRANSFER_MS 90000u
#define MH_IDLE_MS 3000u
typedef struct { int fd; uint32_t start, last; } channel;
typedef struct {
    char method[8], path[64];
    char *authorization, *content_type;
    uint32_t length;
    unsigned has_length;
} request;

static int wait_fd(int fd, int writing)
{
    fd_set f; struct timeval t;
    FD_ZERO(&f); FD_SET(fd,&f); t.tv_sec=0; t.tv_usec=100000;
    return select(fd+1,writing?NULL:&f,writing?&f:NULL,NULL,&t);
}
static int expired(channel *c, uint32_t limit)
{ uint32_t now=clock_ms(); return now-c->start>=limit || now-c->last>=MH_IDLE_MS; }
static int receive(channel *c, void *buf, size_t size, uint32_t limit)
{
    while (!expired(c,limit)) {
        int n=wait_fd(c->fd,0);
        if (n<0) return -1;
        if (!n) continue;
        n=recv(c->fd,buf,size,0);
        if (n>0) c->last=clock_ms();
        return n;
    }
    return -1;
}
static int transmit(channel *c, const void *data, size_t size)
{
    const uint8_t *p=data;
    while (size && !expired(c,MH_TRANSFER_MS)) {
        int n=wait_fd(c->fd,1);
        if (n<0) return -1;
        if (!n) continue;
        n=send(c->fd,p,size,0);
        if (n<=0) return -1;
        c->last=clock_ms(); p+=n; size-=(size_t)n;
    }
    return size?-1:0;
}
static int response(channel *c, unsigned status, const char *body)
{
    char head[256]; size_t len=strlen(body);
    int n=snprintf(head,sizeof(head),"HTTP/1.1 %u Result\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: %u\r\n\r\n",status,(unsigned)len);
    if (n<0 || (size_t)n>=sizeof(head)) return -1;
    c->start=c->last=clock_ms();
    return transmit(c,head,(size_t)n) || transmit(c,body,len) ? -1 : 0;
}
static int lower_hex_64(const char *s)
{
    size_t i;
    if (!s || strlen(s)!=64) return 0;
    for (i=0;i<64;i++) if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
    return 1;
}
static int same_secret(const char *a, const char *b, size_t size)
{ size_t i; unsigned diff=0; for (i=0;i<size;i++) diff|=(unsigned char)a[i]^(unsigned char)b[i]; return diff==0; }
static int key_is(const char *p, const char *key)
{
    while (*p && *key) {
        unsigned a=(unsigned char)*p++,b=(unsigned char)*key++;
        if (a>='A' && a<='Z') a+='a'-'A';
        if (a!=b) return 0;
    }
    return !*p && !*key;
}
static int decimal(const char *s, uint32_t *result)
{
    uint32_t v=0;
    if (!*s) return -1;
    for (;*s;s++) {
        unsigned digit=(unsigned)(*s-'0');
        if (digit>9 || v>(MC_MAX_PACKAGE-digit)/10) return -1;
        v=v*10+digit;
    }
    *result=v; return 0;
}
/* Only origin-form HTTP/1.1; no chunking, duplicate critical headers, browser
 * origins, 100-continue, URL credentials, query parameters or folded lines. */
static int parse(char *head, request *r)
{
    char *end=strstr(head,"\r\n"), *line; char version[16], extra; unsigned host=0;
    size_t i;
    if (!end) return -1;
    *end=0; memset(r,0,sizeof(*r));
    if (sscanf(head,"%7s %63s %15s %c",r->method,r->path,version,&extra)!=3 || strcmp(version,"HTTP/1.1") || r->path[0]!='/' || strchr(r->path,'?') || strchr(r->path,'%')) return -1;
    line=end+2;
    while (*line) {
        char *colon, *value;
        end=strstr(line,"\r\n"); if (!end) return -1;
        *end=0; colon=strchr(line,':');
        if (!colon || colon==line || line[0]==' ' || line[0]=='\t') return -1;
        *colon=0;
        for (i=0;line[i];i++) if (!((line[i]>='a' && line[i]<='z') || (line[i]>='A' && line[i]<='Z') || line[i]=='-')) return -1;
        value=colon+1; while (*value==' ' || *value=='\t') value++;
        for (i=0;value[i];i++) if ((unsigned char)value[i]<32 || (unsigned char)value[i]>126) return -1;
        if (key_is(line,"authorization")) { if (r->authorization) return -1; r->authorization=value; }
        else if (key_is(line,"content-length")) { if (r->has_length++ || decimal(value,&r->length)) return -1; }
        else if (key_is(line,"content-type")) { if (r->content_type) return -1; r->content_type=value; }
        else if (key_is(line,"host")) { if (host++ || !*value) return -1; }
        else if (key_is(line,"transfer-encoding") || key_is(line,"expect") || key_is(line,"origin")) return -1;
        line=end+2;
    }
    return host==1?0:-1;
}
static int read_exact(channel *c, uint8_t *out, size_t size, const uint8_t *prefix, size_t have)
{
    if (have>size) return -1;
    memcpy(out,prefix,have);
    while (have<size) {
        int n=receive(c,out+have,size-have,MH_TRANSFER_MS);
        if (n<=0) return -1;
        have+=(size_t)n;
    }
    return 0;
}
static unsigned code(mc_result r)
{ return r==MC_ERR_DISABLED?503:(r==MC_ERR_IO?500:409); }
static int reboot_ready(const mh_server_config *cfg)
{ return cfg->restore->state==MC_COMMITTED && cfg->reboot && cfg->reboot_ready && cfg->reboot_ready(cfg->device); }
static void result(channel *c, mc_result r, mc_context *core)
{
    char body[224];
    snprintf(body,sizeof(body),"{\"state\":\"%s\",\"result\":\"%s\",\"header_may_be_valid\":%s}\n",mc_state_name(core->state),mc_error_name(r),core->header_may_be_valid?"true":"false");
    response(c,r==MC_OK?200:code(r),body);
}
static void client(int fd, const mh_server_config *cfg)
{
    char input[MH_HEADER_LIMIT+1]; size_t used=0,head_size=0,have=0; char *end;
    uint8_t *prefix; request r; channel c={fd,clock_ms(),clock_ms()}; mc_context *core=cfg->restore;
    while (used<MH_HEADER_LIMIT) {
        int n=receive(&c,input+used,MH_HEADER_LIMIT-used,MH_HEADER_MS);
        if (n<=0) return;
        /* Embedded NUL in headers is rejected; body may be binary. */
        used+=(size_t)n; input[used]=0;
        end=strstr(input,"\r\n\r\n");
        if (end) { head_size=(size_t)(end-input)+4; break; }
        if (memchr(input,0,used)) { response(&c,400,"{\"error\":\"headers\"}\n"); return; }
    }
    if (!head_size || memchr(input,0,head_size)) { response(&c,400,"{\"error\":\"headers\"}\n"); return; }
    input[head_size-2]=0;
    if (parse(input,&r)) { response(&c,400,"{\"error\":\"headers\"}\n"); return; }
    if (!r.authorization || strlen(r.authorization)!=71 || memcmp(r.authorization,"Bearer ",7) || !same_secret(r.authorization+7,cfg->token,64)) { response(&c,401,"{\"error\":\"authorization\"}\n"); return; }
    prefix=(uint8_t *)input+head_size; have=used-head_size;
    if (have>r.length) { response(&c,400,"{\"error\":\"length\"}\n"); return; }
    if (!strcmp(r.method,"GET") && !r.length) {
        if (!strcmp(r.path,"/v1/status")) {
            char body[384];
            snprintf(body,sizeof(body),"{\"state\":\"%s\",\"error\":\"%s\",\"boot_contract_verified\":%s,\"received_bytes\":%u,\"package_bytes\":%u,\"header_may_be_valid\":%s,\"backup_bytes\":%u,\"reboot_available\":%s}\n",mc_state_name(core->state),mc_error_name(core->last_error),core->policy.verified_boot_contract?"true":"false",(unsigned)core->received_bytes,(unsigned)core->total_bytes,core->header_may_be_valid?"true":"false",(unsigned)cfg->backup_bytes,reboot_ready(cfg)?"true":"false");
            response(&c,200,body); return;
        }
        if (!strcmp(r.path,"/v1/backup")) {
            uint8_t buf[512]; uint32_t off=0; char header[256]; int n;
            if (!cfg->backup_read || !cfg->backup_bytes || cfg->backup_bytes>MC_MAX_PACKAGE) { response(&c,503,"{\"error\":\"backup_unavailable\"}\n"); return; }
            n=snprintf(header,sizeof(header),"HTTP/1.1 200 OK\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/octet-stream\r\nContent-Length: %u\r\n\r\n",(unsigned)cfg->backup_bytes);
            if (n<0 || (size_t)n>=sizeof(header) || transmit(&c,header,(size_t)n)) return;
            while (off<cfg->backup_bytes) {
                size_t count=cfg->backup_bytes-off; if (count>sizeof(buf)) count=sizeof(buf);
                if (cfg->backup_read(cfg->device,off,buf,count) || transmit(&c,buf,count)) return;
                off+=(uint32_t)count;
            }
            return;
        }
    } else if (!strcmp(r.method,"POST")) {
        if (!r.has_length) { response(&c,411,"{\"error\":\"length_required\"}\n"); return; }
        if (!strcmp(r.path,"/v1/restore")) {
            uint8_t buf[512]; uint32_t consumed=(uint32_t)have; mc_result rc;
            if (!r.content_type || strcmp(r.content_type,"application/octet-stream")) { response(&c,415,"{\"error\":\"content_type\"}\n"); return; }
            rc=mc_begin(core,r.length);
            if (rc!=MC_OK) { result(&c,rc,core); return; }
            rc=mc_feed(core,prefix,have);
            while (rc==MC_OK && consumed<r.length) {
                size_t count=r.length-consumed; int n;
                if (count>sizeof(buf)) count=sizeof(buf);
                n=receive(&c,buf,count,MH_TRANSFER_MS);
                if (n<=0) { mc_abort(core); return; }
                consumed+=(uint32_t)n; rc=mc_feed(core,buf,(size_t)n);
            }
            if (rc==MC_OK) rc=mc_finish(core);
            result(&c,rc,core); return;
        }
        if (!strcmp(r.path,"/v1/restore/commit")) {
            uint8_t confirmation[65]; char digest[65]; unsigned i;
            if (r.length!=64 || !r.content_type || strcmp(r.content_type,"text/plain")) { response(&c,400,"{\"error\":\"digest_required\"}\n"); return; }
            if (read_exact(&c,confirmation,64,prefix,have)) return;
            confirmation[64]=0;
            for (i=0;i<32;i++) snprintf(digest+2*i,3,"%02x",core->policy.trusted_stock_sha256[i]);
            if (!lower_hex_64((char *)confirmation) || !same_secret((char *)confirmation,digest,64)) { response(&c,409,"{\"error\":\"digest_mismatch\"}\n"); return; }
            result(&c,mc_commit(core),core); return;
        }
        if (!strcmp(r.path,"/v1/restore/abort") && !r.length) { result(&c,mc_abort(core),core); return; }
        if (!strcmp(r.path,"/v1/reboot") && !r.length) {
            if (core->state!=MC_COMMITTED || !cfg->reboot) { response(&c,409,"{\"error\":\"not_committed\"}\n"); return; }
            if (!reboot_ready(cfg)) { response(&c,503,"{\"error\":\"reboot_unavailable\"}\n"); return; }
            if (!response(&c,202,"{\"state\":\"reboot_requested\"}\n")) cfg->reboot(cfg->device);
            return;
        }
    }
    response(&c,404,"{\"error\":\"route\"}\n");
}

int maintenance_http_serve(const char *bind_ip, unsigned port, const mh_server_config *cfg)
{
    int fd,one=1; struct sockaddr_in addr;
    if (!cfg || !cfg->restore || !lower_hex_64(cfg->token) || !bind_ip || !port || port>65535) return -1;
    memset(&addr,0,sizeof(addr)); addr.sin_family=AF_INET; addr.sin_port=htons((uint16_t)port); addr.sin_addr.s_addr=inet_addr(bind_ip);
    if (addr.sin_addr.s_addr==INADDR_NONE) return -1;
    fd=socket(AF_INET,SOCK_STREAM,0); if (fd<0) return -1;
    setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one));
    if (bind(fd,(struct sockaddr *)&addr,sizeof(addr)) || listen(fd,1)) { close(fd); return -1; }
    for (;;) {
        int peer=accept(fd,NULL,NULL); if (peer<0) break;
        if (ioctl(peer,FIONBIO,&one)==0) client(peer,cfg);
        close(peer);
    }
    close(fd); return -1;
}

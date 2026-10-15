/* SPDX-License-Identifier: Apache-2.0 */
#include "maintenance_core.h"
#include <string.h>

typedef struct { uint32_t h[8]; uint64_t bytes; uint8_t block[64]; size_t used; } sha_state;
static uint32_t ror(uint32_t x, unsigned n) { return (x >> n) | (x << (32u - n)); }
static uint32_t be32(const uint8_t *p)
{ return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static uint32_t le32(const uint8_t *p)
{ return p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static void sha_block(sha_state *s, const uint8_t *p)
{
    static const uint32_t k[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    };
    uint32_t w[64], a,b,c,d,e,f,g,h,t1,t2;
    unsigned i;
    for (i=0;i<16;i++) w[i]=be32(p+4*i);
    for (i=16;i<64;i++) {
        uint32_t x=w[i-15],y=w[i-2];
        w[i]=w[i-16]+(ror(x,7)^ror(x,18)^(x>>3))+w[i-7]+(ror(y,17)^ror(y,19)^(y>>10));
    }
    a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
    for (i=0;i<64;i++) {
        t1=h+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^((~e)&g))+k[i]+w[i];
        t2=(ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c));
        h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
    }
    s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(sha_state *s)
{
    static const uint32_t iv[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    memset(s,0,sizeof(*s));memcpy(s->h,iv,sizeof(iv));
}
static void sha_update(sha_state *s, const uint8_t *p, size_t n)
{
    s->bytes+=(uint64_t)n;
    while (n) {
        size_t z=64-s->used;if(z>n)z=n;
        memcpy(s->block+s->used,p,z);s->used+=z;p+=z;n-=z;
        if(s->used==64){sha_block(s,s->block);s->used=0;}
    }
}
static void sha_final(sha_state *s, uint8_t out[32])
{
    uint64_t bits=s->bytes*8;unsigned i;
    s->block[s->used++]=0x80;
    if(s->used>56){memset(s->block+s->used,0,64-s->used);sha_block(s,s->block);s->used=0;}
    memset(s->block+s->used,0,56-s->used);
    for(i=0;i<8;i++)s->block[63-i]=(uint8_t)(bits>>(8*i));
    sha_block(s,s->block);
    for(i=0;i<32;i++)out[i]=(uint8_t)(s->h[i/4]>>(24-8*(i%4)));
    memset(s,0,sizeof(*s));
}
void mc_sha256(const void *data, size_t size, uint8_t out[32])
{ sha_state s;sha_init(&s);sha_update(&s,(const uint8_t *)data,size);sha_final(&s,out); }
mc_result mc_sha256_read(int (*read)(void *,uint32_t,void *,size_t),void *user,
                        uint32_t offset,uint32_t size,uint8_t out[32])
{
    sha_state s;uint8_t b[256];uint32_t done=0;
    if(!read || !out)return MC_ERR_ARGUMENT;
    if(size>MC_MAX_PACKAGE || offset>UINT32_MAX-size)return MC_ERR_BOUNDS;
    sha_init(&s);
    while(done<size){
        size_t n=size-done;if(n>sizeof(b))n=sizeof(b);
        if(read(user,offset+done,b,n)!=0){memset(&s,0,sizeof(s));return MC_ERR_IO;}
        sha_update(&s,b,n);done+=(uint32_t)n;
    }
    sha_final(&s,out);return MC_OK;
}
static uint32_t crc_update(uint32_t c,const uint8_t *p,size_t n)
{
    size_t i;unsigned j;
    for(i=0;i<n;i++){c^=p[i];for(j=0;j<8;j++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);}
    return c;
}
uint32_t mc_crc32(const void *data,size_t size)
{ return ~crc_update(0xffffffffu,(const uint8_t *)data,size); }
static int equal(const uint8_t *a,const uint8_t *b,size_t n)
{ unsigned d=0;size_t i;for(i=0;i<n;i++)d|=a[i]^b[i];return d==0; }
static mc_result reject(mc_context *c,mc_result r)
{ if(c)c->last_error=r;return r; }
static mc_result fail(mc_context *c,mc_result r)
{ c->state=MC_ERROR;return reject(c,r); }
static int bounded(mc_context *c,uint32_t off,size_t n)
{ return off<=c->policy.staging_capacity && n<=(size_t)(c->policy.staging_capacity-off); }
static int rd(mc_context *c,uint32_t off,void *p,size_t n)
{ return !bounded(c,off,n) || c->backend.read(c->backend.user,off,p,n)!=0; }
static int wr(mc_context *c,uint32_t off,const void *p,size_t n)
{ return !bounded(c,off,n) || c->backend.write(c->backend.user,off,p,n)!=0; }
static int erase(mc_context *c,uint32_t off,size_t n)
{
    return !bounded(c,off,n) || off%c->backend.erase_size || n%c->backend.erase_size ||
           c->backend.erase(c->backend.user,off,n)!=0;
}
static int text_field(const uint8_t *p,size_t n)
{ size_t i;for(i=0;i<n;i++){if(!p[i])return 1;if(p[i]<32 || p[i]>126)return 0;}return 0; }
static mc_result header_check(mc_context *c)
{
    uint32_t packed=le32(c->header+88),raw=le32(c->header+84);
    if(memcmp(c->header,"RBL\0",4) || le32(c->header+4)!=0x402 ||
       memcmp(c->header+12,"app\0",4) || !text_field(c->header+28,24) ||
       !text_field(c->header+52,24) || mc_crc32(c->header,92)!=le32(c->header+92))
        return MC_ERR_FORMAT;
    if(!raw || raw>MC_MAX_PACKAGE || !packed || packed%16 || packed!=c->total_bytes-MC_HEADER_SIZE ||
       raw>c->policy.app_capacity-MC_HEADER_SIZE)return MC_ERR_BOUNDS;
    return MC_OK;
}
static mc_result blank_header(mc_context *c)
{
    uint8_t b[MC_HEADER_SIZE];size_t i;
    if(rd(c,0,b,sizeof(b)))return MC_ERR_IO;
    for(i=0;i<sizeof(b);i++)if(b[i]!=0xff)return MC_ERR_INTEGRITY;
    return MC_OK;
}
static mc_result prepare_stage(mc_context *c)
{
    uint32_t block=c->backend.erase_size;
    uint32_t count=(c->total_bytes+block-1)/block;
    mc_result r;
    /* First operation removes any earlier boot-consumable marker. The loader
     * must be independently known to reject an erased or partial RBL header. */
    c->staging_invalidated=1;
    c->header_may_be_valid=1;
    if(erase(c,0,block))return MC_ERR_IO;
    r=blank_header(c);if(r!=MC_OK)return r;
    c->header_may_be_valid=0;
    if(count>1 && erase(c,block,(size_t)(count-1)*block))return MC_ERR_IO;
    return MC_OK;
}
mc_result mc_init(mc_context *c,const mc_backend *backend,const mc_policy *policy)
{
    unsigned nonzero=0;size_t i;
    if(!c)return MC_ERR_ARGUMENT;
    memset(c,0,sizeof(*c));c->state=MC_DISABLED;c->header_may_be_valid=1;
    if(!backend || !policy)return reject(c,MC_ERR_ARGUMENT);
    c->backend=*backend;c->policy=*policy;
    if(policy->verified_boot_contract!=1)return reject(c,MC_ERR_DISABLED);
    for(i=0;i<32;i++)nonzero|=policy->trusted_stock_sha256[i];
    if(!nonzero)return reject(c,MC_ERR_DISABLED);
    if(!backend->read || !backend->erase || !backend->write ||
       backend->erase_size<MC_HEADER_SIZE || backend->erase_size>MC_MAX_PACKAGE ||
       policy->staging_capacity<backend->erase_size || policy->staging_capacity>MC_MAX_PACKAGE ||
       policy->staging_capacity%backend->erase_size || policy->app_capacity<=MC_HEADER_SIZE ||
       policy->app_capacity>MC_MAX_PACKAGE)return reject(c,MC_ERR_ARGUMENT);
    c->state=MC_IDLE;return MC_OK;
}
mc_result mc_begin(mc_context *c,uint32_t total)
{
    if(!c)return MC_ERR_ARGUMENT;
    if(c->state==MC_DISABLED)return reject(c,MC_ERR_DISABLED);
    if(c->state!=MC_IDLE)return reject(c,MC_ERR_STATE);
    if(total<=MC_HEADER_SIZE || total>MC_MAX_PACKAGE || total>c->policy.staging_capacity)
        return reject(c,MC_ERR_BOUNDS);
    memset(c->header,0,sizeof(c->header));c->total_bytes=total;c->received_bytes=0;
    c->staging_invalidated=0;c->state=MC_RECEIVING;c->last_error=MC_OK;
    return MC_OK;
}
mc_result mc_feed(mc_context *c,const uint8_t *data,size_t size)
{
    mc_result r;
    if(!c)return MC_ERR_ARGUMENT;
    if(c->state!=MC_RECEIVING)return reject(c,MC_ERR_STATE);
    if((!data && size) || size>(size_t)(c->total_bytes-c->received_bytes))return fail(c,MC_ERR_BOUNDS);
    if(c->received_bytes<MC_HEADER_SIZE){
        size_t n=MC_HEADER_SIZE-c->received_bytes;if(n>size)n=size;
        if(n){memcpy(c->header+c->received_bytes,data,n);data+=n;size-=n;c->received_bytes+=(uint32_t)n;}
        if(c->received_bytes==MC_HEADER_SIZE){
            r=header_check(c);if(r!=MC_OK)return fail(c,r);
            r=prepare_stage(c);if(r!=MC_OK)return fail(c,r);
        }
    }
    while(size){
        size_t n=size>256?256:size;
        if(wr(c,c->received_bytes,data,n))return fail(c,MC_ERR_IO);
        data+=n;size-=n;c->received_bytes+=(uint32_t)n;
    }
    return MC_OK;
}
static mc_result verify_stage(mc_context *c)
{
    sha_state sha;uint8_t b[256],hash[32];uint32_t off=MC_HEADER_SIZE,crc=0xffffffffu;mc_result r;
    r=blank_header(c);if(r!=MC_OK)return r;
    sha_init(&sha);sha_update(&sha,c->header,MC_HEADER_SIZE);
    while(off<c->total_bytes){
        size_t n=c->total_bytes-off;if(n>sizeof(b))n=sizeof(b);
        if(rd(c,off,b,n))return MC_ERR_IO;
        sha_update(&sha,b,n);crc=crc_update(crc,b,n);off+=(uint32_t)n;
    }
    sha_final(&sha,hash);
    if(~crc!=le32(c->header+76) || !equal(hash,c->policy.trusted_stock_sha256,32))return MC_ERR_INTEGRITY;
    return MC_OK;
}
mc_result mc_finish(mc_context *c)
{
    mc_result r;
    if(!c)return MC_ERR_ARGUMENT;
    if(c->state!=MC_RECEIVING)return reject(c,MC_ERR_STATE);
    if(c->received_bytes!=c->total_bytes)return fail(c,MC_ERR_INCOMPLETE);
    r=verify_stage(c);if(r!=MC_OK)return fail(c,r);
    c->state=MC_VERIFIED;c->last_error=MC_OK;return MC_OK;
}
mc_result mc_commit(mc_context *c)
{
    mc_result r;uint8_t header[MC_HEADER_SIZE];
    if(!c)return MC_ERR_ARGUMENT;
    if(c->state!=MC_VERIFIED)return reject(c,MC_ERR_STATE);
    /* Recheck storage after the confirmation delay, before publishing marker. */
    r=verify_stage(c);if(r!=MC_OK)return fail(c,r);
    c->header_may_be_valid=1;
    if(wr(c,0,c->header,MC_HEADER_SIZE) || rd(c,0,header,MC_HEADER_SIZE))return fail(c,MC_ERR_IO);
    if(!equal(header,c->header,MC_HEADER_SIZE))return fail(c,MC_ERR_INTEGRITY);
    c->state=MC_COMMITTED;c->last_error=MC_OK;return MC_OK;
}
mc_result mc_abort(mc_context *c)
{
    mc_result r;
    if(!c)return MC_ERR_ARGUMENT;
    if(c->state==MC_DISABLED)return reject(c,MC_ERR_DISABLED);
    if(c->state==MC_COMMITTED)return reject(c,MC_ERR_STATE);
    if(c->staging_invalidated){
        if(erase(c,0,c->backend.erase_size))return fail(c,MC_ERR_IO);
        r=blank_header(c);if(r!=MC_OK)return fail(c,r);
        c->header_may_be_valid=0;
    }
    memset(c->header,0,sizeof(c->header));c->staging_invalidated=0;
    c->total_bytes=0;c->received_bytes=0;c->state=MC_IDLE;c->last_error=MC_OK;return MC_OK;
}
const char *mc_state_name(mc_state state)
{
    switch(state){case MC_DISABLED:return "disabled";case MC_IDLE:return "idle";case MC_RECEIVING:return "receiving";
        case MC_VERIFIED:return "verified";case MC_COMMITTED:return "committed";case MC_ERROR:return "error";default:return "unknown";}
}
const char *mc_error_name(mc_result r)
{
    switch(r){case MC_OK:return "ok";case MC_ERR_DISABLED:return "restore_disabled";case MC_ERR_ARGUMENT:return "invalid_argument";
        case MC_ERR_STATE:return "invalid_state";case MC_ERR_FORMAT:return "invalid_rbl_header";case MC_ERR_BOUNDS:return "out_of_bounds";
        case MC_ERR_IO:return "storage_io_error";case MC_ERR_INTEGRITY:return "integrity_mismatch";case MC_ERR_INCOMPLETE:return "incomplete_upload";
        default:return "unknown_error";}
}

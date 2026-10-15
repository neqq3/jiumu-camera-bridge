/* SPDX-License-Identifier: Apache-2.0 */
/* Synthetic storage faults verify this transaction, NOT an unknown loader's
 * boot/copy/rollback behavior. No retail image, encryption key or ID is used. */
#include "maintenance_core.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define CAPACITY 4096u
#define BODY_SIZE 1024u
#define PACKAGE_SIZE (MC_HEADER_SIZE+BODY_SIZE)
typedef struct {
    uint8_t before[16], bytes[CAPACITY], after[16];
    unsigned ops, reads, erases, writes, fail_op;
    int torn_header; /* -1 normal; otherwise write this many marker bytes then fail */
    int torn_erase;
    uint32_t largest;
} flash;
static uint8_t package[PACKAGE_SIZE];
static void put32(uint8_t *p,uint32_t v)
{ p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);p[2]=(uint8_t)(v>>16);p[3]=(uint8_t)(v>>24); }
static uint32_t get32(const uint8_t *p)
{ return p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); }
static int access_flash(flash *f,uint32_t off,size_t n)
{
    size_t i;
    assert(off<=CAPACITY && n<=CAPACITY-off);
    for(i=0;i<16;i++)assert(f->before[i]==0x5a && f->after[i]==0xa5);
    if(off+n>f->largest)f->largest=off+(uint32_t)n;
    f->ops++;return f->fail_op && f->ops==f->fail_op;
}
static int read_flash(void *user,uint32_t off,void *data,size_t n)
{ flash *f=user;f->reads++;if(access_flash(f,off,n))return -1;memcpy(data,f->bytes+off,n);return 0; }
static int erase_flash(void *user,uint32_t off,size_t n)
{
    flash *f=user;assert(off%256==0 && n%256==0);f->erases++;
    if(access_flash(f,off,n))return -1;
    if(off==0 && f->torn_erase>=0){assert((size_t)f->torn_erase<=n);memset(f->bytes,0xff,(size_t)f->torn_erase);return -1;}
    memset(f->bytes+off,0xff,n);return 0;
}
static int write_flash(void *user,uint32_t off,const void *data,size_t n)
{
    flash *f=user;const uint8_t *p=data;size_t i,write_n=n;int torn=off==0 && f->torn_header>=0;
    f->writes++;if(access_flash(f,off,n))return -1;
    if(torn){assert(n==96);write_n=(size_t)f->torn_header;assert(write_n<=n);}
    for(i=0;i<write_n;i++){assert((f->bytes[off+i]&p[i])==p[i]);f->bytes[off+i]&=p[i];}
    return torn?-1:0;
}
static void make_package(void)
{
    unsigned i;memset(package,0,sizeof(package));memcpy(package,"RBL\0",4);
    put32(package+4,0x402);put32(package+8,12345);memcpy(package+12,"app",3);
    memcpy(package+28,"test-only",9);memcpy(package+52,"synthetic",9);
    for(i=0;i<BODY_SIZE;i++)package[96+i]=(uint8_t)(i*17u+29u);
    put32(package+76,mc_crc32(package+96,BODY_SIZE));put32(package+80,0x12345678);
    put32(package+84,1536);put32(package+88,BODY_SIZE);put32(package+92,mc_crc32(package,92));
}
static void reset_flash(flash *f)
{
    memset(f,0,sizeof(*f));memset(f->before,0x5a,16);memset(f->after,0xa5,16);
    memset(f->bytes,0x3c,sizeof(f->bytes));f->torn_header=-1;f->torn_erase=-1;
}
static mc_backend backend(flash *f)
{ mc_backend b={f,read_flash,erase_flash,write_flash,256};return b; }
static mc_policy policy(void)
{
    mc_policy p;memset(&p,0,sizeof(p));p.verified_boot_contract=1;
    p.app_capacity=2048;p.staging_capacity=CAPACITY;mc_sha256(package,sizeof(package),p.trusted_stock_sha256);return p;
}
static void setup(mc_context *c,flash *f)
{ mc_backend b;mc_policy p=policy();reset_flash(f);b=backend(f);assert(mc_init(c,&b,&p)==MC_OK);assert(f->ops==0); }
static int header_erased(flash *f)
{ size_t i;for(i=0;i<96;i++)if(f->bytes[i]!=0xff)return 0;return 1; }
static int complete_rbl(flash *f)
{
    return !memcmp(f->bytes,"RBL\0",4) && mc_crc32(f->bytes,92)==get32(f->bytes+92) &&
        get32(f->bytes+88)==BODY_SIZE && mc_crc32(f->bytes+96,BODY_SIZE)==get32(f->bytes+76);
}
static void feed_chunks(mc_context *c,size_t chunk)
{
    size_t off=0;assert(mc_begin(c,PACKAGE_SIZE)==MC_OK);
    while(off<PACKAGE_SIZE){size_t n=PACKAGE_SIZE-off;if(n>chunk)n=chunk;assert(mc_feed(c,package+off,n)==MC_OK);off+=n;}
}
static void hash_vectors(void)
{
    static const char *inputs[]={"","abc","abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"};
    static const char *expected[]={
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"};
    static uint8_t million_a[1000000];
    uint8_t hash[32],other[32];char hex[65];unsigned i,j;flash f;
    for(i=0;i<3;i++){mc_sha256(inputs[i],strlen(inputs[i]),hash);for(j=0;j<32;j++)sprintf(hex+j*2,"%02x",hash[j]);assert(!strcmp(hex,expected[i]));}
    assert(mc_crc32("123456789",9)==0xcbf43926u);
    memset(million_a,'a',sizeof(million_a));mc_sha256(million_a,sizeof(million_a),hash);
    for(j=0;j<32;j++)sprintf(hex+j*2,"%02x",hash[j]);
    assert(!strcmp(hex,"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
    reset_flash(&f);memcpy(f.bytes,package,sizeof(package));mc_sha256(package,sizeof(package),hash);
    for(j=0;j<32;j++)sprintf(hex+j*2,"%02x",hash[j]);
    /* Fixture digest independently computed with Python hashlib/zlib. */
    assert(!strcmp(hex,"8f54fda00ed6f00863e286355aebd4149777216855d24609c3ef39c2bc1fe13b"));
    assert(mc_sha256_read(read_flash,&f,0,sizeof(package),other)==MC_OK);assert(!memcmp(hash,other,32));
    assert(mc_sha256_read(read_flash,&f,UINT32_MAX,2,other)==MC_ERR_BOUNDS);
    f.fail_op=f.ops+1;assert(mc_sha256_read(read_flash,&f,0,16,other)==MC_ERR_IO);
}
static void guards_and_states(void)
{
    flash f;mc_context c;mc_backend b;mc_policy p;
    reset_flash(&f);b=backend(&f);p=policy();p.verified_boot_contract=0;
    assert(mc_init(&c,&b,&p)==MC_ERR_DISABLED);assert(mc_begin(&c,PACKAGE_SIZE)==MC_ERR_DISABLED);assert(mc_abort(&c)==MC_ERR_DISABLED);assert(f.ops==0);
    p=policy();memset(p.trusted_stock_sha256,0,32);assert(mc_init(&c,&b,&p)==MC_ERR_DISABLED);assert(f.ops==0);
    p=policy();p.staging_capacity--;assert(mc_init(&c,&b,&p)==MC_ERR_ARGUMENT);
    setup(&c,&f);assert(mc_finish(&c)==MC_ERR_STATE);assert(mc_commit(&c)==MC_ERR_STATE);
    assert(mc_begin(&c,96)==MC_ERR_BOUNDS);assert(mc_begin(&c,UINT32_MAX)==MC_ERR_BOUNDS);
    assert(mc_begin(&c,CAPACITY+1)==MC_ERR_BOUNDS);assert(f.ops==0);
    assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_begin(&c,PACKAGE_SIZE)==MC_ERR_STATE);
    assert(mc_feed(&c,NULL,0)==MC_OK);assert(mc_feed(&c,package,PACKAGE_SIZE+1)==MC_ERR_BOUNDS);
    assert(mc_abort(&c)==MC_OK);assert(f.ops==0);
    feed_chunks(&c,1);assert(header_erased(&f));assert(!memcmp(f.bytes+96,package+96,BODY_SIZE));
    assert(mc_finish(&c)==MC_OK);assert(mc_feed(&c,package,1)==MC_ERR_STATE);assert(mc_finish(&c)==MC_ERR_STATE);
    assert(mc_commit(&c)==MC_OK);assert(c.state==MC_COMMITTED && c.header_may_be_valid);assert(complete_rbl(&f));
    assert(mc_commit(&c)==MC_ERR_STATE);assert(mc_abort(&c)==MC_ERR_STATE);assert(mc_begin(&c,PACKAGE_SIZE)==MC_ERR_STATE);
}
static void truncation_and_restart(void)
{
    flash f;mc_context c,rebooted;mc_backend b;mc_policy p=policy();size_t prefix;
    for(prefix=0;prefix<PACKAGE_SIZE;prefix++){
        setup(&c,&f);assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_feed(&c,package,prefix)==MC_OK);
        assert(mc_finish(&c)==MC_ERR_INCOMPLETE);assert(!complete_rbl(&f));
        if(prefix>=96)assert(header_erased(&f));else assert(f.ops==0);
        b=backend(&f);assert(mc_init(&rebooted,&b,&p)==MC_OK);assert(mc_commit(&rebooted)==MC_ERR_STATE);
        assert(mc_abort(&c)==MC_OK);assert(c.state==MC_IDLE);
    }
    setup(&c,&f);feed_chunks(&c,257);assert(mc_finish(&c)==MC_OK);assert(header_erased(&f));
    b=backend(&f);assert(mc_init(&rebooted,&b,&p)==MC_OK);assert(mc_commit(&rebooted)==MC_ERR_STATE);
    assert(mc_abort(&c)==MC_OK);assert(header_erased(&f));assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);
}
static void malformed_and_untrusted(void)
{
    flash f;mc_context c;uint8_t bad[PACKAGE_SIZE];unsigned i;mc_backend b;mc_policy p;
    for(i=0;i<96;i++){
        setup(&c,&f);memcpy(bad,package,sizeof(bad));bad[i]^=1;
        assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_feed(&c,bad,96)==MC_ERR_FORMAT);assert(f.ops==0);
    }
    for(i=0;i<7;i++){
        setup(&c,&f);memcpy(bad,package,sizeof(bad));
        switch(i){case 0:memcpy(bad+12,"bootloader",10);break;case 1:put32(bad+4,0x102);break;
            case 2:put32(bad+84,2048);break;case 3:put32(bad+88,1000);break;
            case 4:memset(bad+28,'a',24);break;case 5:bad[52]=1;break;default:put32(bad+84,0);break;}
        put32(bad+92,mc_crc32(bad,92));assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_feed(&c,bad,sizeof(bad))!=MC_OK);assert(f.ops==0);
    }
    /* A perfectly CRC-consistent alternate package cannot authorize itself. */
    setup(&c,&f);memcpy(bad,package,sizeof(bad));bad[100]^=1;
    put32(bad+76,mc_crc32(bad+96,BODY_SIZE));put32(bad+92,mc_crc32(bad,92));
    assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_feed(&c,bad,sizeof(bad))==MC_OK);
    assert(mc_finish(&c)==MC_ERR_INTEGRITY);assert(header_erased(&f));assert(mc_commit(&c)==MC_ERR_STATE);
    /* Correct package with a different trusted hash also fails. */
    setup(&c,&f);p=policy();p.trusted_stock_sha256[0]^=1;b=backend(&f);assert(mc_init(&c,&b,&p)==MC_OK);
    feed_chunks(&c,13);assert(mc_finish(&c)==MC_ERR_INTEGRITY);assert(header_erased(&f));
    /* Mutating caller-owned policy after init cannot turn on or change trust. */
    p.verified_boot_contract=0;memset(p.trusted_stock_sha256,0,32);assert(c.policy.verified_boot_contract==1);
}
static void corruption_and_commit(void)
{
    flash f;mc_context c;unsigned i;
    for(i=0;i<BODY_SIZE;i++){
        setup(&c,&f);feed_chunks(&c,513);f.bytes[96+i]^=1;
        assert(mc_finish(&c)==MC_ERR_INTEGRITY);assert(header_erased(&f));
    }
    setup(&c,&f);feed_chunks(&c,71);assert(mc_finish(&c)==MC_OK);f.bytes[101]^=1;
    assert(mc_commit(&c)==MC_ERR_INTEGRITY);assert(header_erased(&f));assert(!c.header_may_be_valid);
    assert(mc_abort(&c)==MC_OK);feed_chunks(&c,800);assert(mc_finish(&c)==MC_OK);
    f.bytes[0]=0;assert(mc_commit(&c)==MC_ERR_INTEGRITY);
    /* Partial header write: valid marker can exist only if all marker bytes
     * were stored, and then the fully verified body already exists. */
    for(i=0;i<=96;i++){
        setup(&c,&f);feed_chunks(&c,37);assert(mc_finish(&c)==MC_OK);f.torn_header=(int)i;
        assert(mc_commit(&c)==MC_ERR_IO);assert(c.state==MC_ERROR && c.header_may_be_valid);
        if(complete_rbl(&f))assert(!memcmp(f.bytes,package,sizeof(package)));
        f.torn_header=-1;assert(mc_abort(&c)==MC_OK);assert(header_erased(&f));
    }
}
static void every_storage_failure(void)
{
    flash f;mc_context c;unsigned all_ops,n;
    setup(&c,&f);feed_chunks(&c,PACKAGE_SIZE);assert(mc_finish(&c)==MC_OK);assert(mc_commit(&c)==MC_OK);all_ops=f.ops;
    for(n=1;n<=all_ops;n++){
        mc_result r;
        setup(&c,&f);f.fail_op=n;assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);
        r=mc_feed(&c,package,sizeof(package));if(r==MC_OK)r=mc_finish(&c);if(r==MC_OK)r=mc_commit(&c);
        assert(r==MC_ERR_IO);assert(c.state==MC_ERROR);
        if(complete_rbl(&f))assert(!memcmp(f.bytes,package,sizeof(package)));
        f.fail_op=0;assert(mc_abort(&c)==MC_OK);assert(header_erased(&f));assert(f.largest<=CAPACITY);
    }
    setup(&c,&f);feed_chunks(&c,100);f.fail_op=f.ops+1;
    assert(mc_abort(&c)==MC_ERR_IO);assert(c.state==MC_ERROR);f.fail_op=0;assert(mc_abort(&c)==MC_OK);
    /* An old valid staged image remains untouched on malformed metadata. */
    setup(&c,&f);memcpy(f.bytes,package,sizeof(package));assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);
    assert(mc_feed(&c,package,1)==MC_OK);assert(complete_rbl(&f));assert(mc_abort(&c)==MC_OK);assert(complete_rbl(&f));assert(f.ops==0);
    assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);f.fail_op=1;assert(mc_feed(&c,package,96)==MC_ERR_IO);
    assert(c.header_may_be_valid && complete_rbl(&f));f.fail_op=0;assert(mc_abort(&c)==MC_OK);assert(header_erased(&f));
    /* A failed/partial erase cannot be reported as definitely invalidated. */
    for(n=0;n<=256;n++){
        setup(&c,&f);memcpy(f.bytes,package,sizeof(package));f.torn_erase=(int)n;
        assert(mc_begin(&c,PACKAGE_SIZE)==MC_OK);assert(mc_feed(&c,package,96)==MC_ERR_IO);
        assert(c.state==MC_ERROR && c.header_may_be_valid);
        f.torn_erase=-1;assert(mc_abort(&c)==MC_OK);assert(header_erased(&f));assert(!c.header_may_be_valid);
    }
}
int main(void)
{
    make_package();hash_vectors();guards_and_states();truncation_and_restart();
    malformed_and_untrusted();corruption_and_commit();every_storage_failure();
    puts("maintenance core: hashes, trust gate, every truncated prefix, corruption, torn marker, I/O faults, explicit commit/replay passed");
    return 0;
}

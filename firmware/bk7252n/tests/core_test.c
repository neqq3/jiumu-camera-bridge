/* SPDX-License-Identifier: Apache-2.0 */
#include "sp0a39.h"
#include "rtp_jpeg.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int writes, fail_at, wrong_id, read_fail;
static int rd(uint8_t reg,uint8_t *value) { *value=reg==0 ? 0x0a : (wrong_id?0x30:0x39); return read_fail; }
static int wr(uint8_t reg,uint8_t value) { (void)reg;(void)value; ++writes; return writes==fail_at; }
static size_t offset, packets;
static uint16_t expected_seq;
static int packet(void *ctx,const uint8_t *p,size_t n)
{
    jpeg_view *v=ctx;
    size_t hdr=offset?24:156, chunk=n-hdr;
    assert(n<=1400 && n>hdr && p[0]=='$' && p[1]==0 && p[4]==0x80);
    assert((unsigned)p[2]*256+p[3]==n-4);
    assert((unsigned)p[6]*256+p[7]==expected_seq++);
    assert(((unsigned)p[17]<<16)+((unsigned)p[18]<<8)+p[19]==offset);
    assert((p[5]&0x7f)==26 && p[21]==255 && p[22]==80 && p[23]==60);
    assert(!memcmp(p+hdr,v->scan+offset,chunk));
    if (!offset) assert(!memcmp(p+28,v->quant,128));
    offset+=chunk; ++packets;
    assert(!!(p[5]&128)==(offset==v->length));
    return 0;
}
static int abort_write(void *ctx,const uint8_t *p,size_t n) { (void)ctx;(void)p;(void)n; return -1; }
int main(int argc,char **argv)
{
    uint8_t frame[JPEG_FRAME_LIMIT];
    size_t n,i;
    jpeg_view v,tmp;
    uint16_t seq=65534;
    FILE *f;
    assert(argc==2);
    wrong_id=1; assert(sp0a39_init_candidate(rd,wr)==-3 && writes==1);
    wrong_id=0; writes=0; read_fail=1; assert(sp0a39_init_candidate(rd,wr)==-2 && writes==1);
    read_fail=0; writes=0; fail_at=15; assert(sp0a39_init_candidate(rd,wr)==-4 && writes==15);
    writes=0; fail_at=0; assert(sp0a39_init_candidate(rd,wr)==0 && writes>300);
    f=fopen(argv[1],"rb"); assert(f); n=fread(frame,1,sizeof(frame),f); fclose(f);
    assert(!jpeg_parse(frame,n,&v));
    assert(v.width8==80 && v.height8==60);
    expected_seq=seq; assert(!rtp_jpeg_send(&v,9000,1234,&seq,0,packet,&v));
    assert(offset==v.length && packets>1);
    assert(rtp_jpeg_send(&v,9000,1234,&seq,0,abort_write,NULL)==-1);
    /* Every truncated prefix before EOI must fail without out-of-bounds reads. */
    for (i=0;i<n-1;i++) assert(jpeg_parse(frame,i,&tmp)!=0);
    /* Mutations exercise marker, size, tables and entropy boundaries under ASan/UBSan. */
    for (i=0;i<n;i+=7) { uint8_t saved=frame[i]; frame[i]^=255; jpeg_parse(frame,n,&tmp); frame[i]=saved; }
    assert(jpeg_parse(frame,JPEG_FRAME_LIMIT+1,&tmp)!=0);
    puts("sensor failure paths, JPEG bounds and RTP fragmentation passed");
    return 0;
}

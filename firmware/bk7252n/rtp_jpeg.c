/* SPDX-License-Identifier: Apache-2.0 */
#include "rtp_jpeg.h"
#include <string.h>

/* JPEG standard Huffman values, also specified in RFC 2435 Appendix B.
 * RTP/JPEG cannot transport a custom Huffman table. Compare all bytes. */
static const char *const huffman[4] = {
 "00010501010101010100000000000000000102030405060708090a0b",
 "00030101010101010101010000000000000102030405060708090a0b",
 "0002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
 "00020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa"
};
static unsigned nibble(char c) { return c <= '9' ? (unsigned)(c-'0') : (unsigned)(c-'a'+10); }
static unsigned be16(const uint8_t *p) { return ((unsigned)p[0]<<8)|p[1]; }
static void put16(uint8_t *p, unsigned v) { p[0]=(uint8_t)(v>>8); p[1]=(uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p,v>>16); put16(p+2,v); }

int jpeg_parse(const uint8_t *p, size_t n, jpeg_view *out)
{
    size_t pos=2;
    unsigned quant_mask=0, huff_mask=0, sof=0;
    if (!p || !out || n<4 || n>JPEG_FRAME_LIMIT || p[0]!=255 || p[1]!=216) return -1;
    memset(out,0,sizeof(*out));
    while (pos+4<=n) {
        unsigned marker, len;
        const uint8_t *d;
        size_t size;
        if (p[pos++]!=255) return -1;
        marker=p[pos++]; len=be16(p+pos);
        if (len<2 || len>n-pos) return -1;
        d=p+pos+2; size=len-2; pos+=len;
        if (marker==0xdb) {
            while (size) {
                unsigned id=d[0];
                if (size<65 || id>1 || (quant_mask&(1u<<id))) return -1;
                memcpy(out->quant+64*id,d+1,64); quant_mask|=1u<<id;
                d+=65; size-=65;
            }
        } else if (marker==0xc4) {
            while (size) {
                unsigned id=d[0], idx, count=0, i;
                const char *expected;
                if (size<17 || (id!=0 && id!=1 && id!=16 && id!=17)) return -1;
                idx=(id>>4)*2+(id&1); expected=huffman[idx];
                for (i=1;i<=16;i++) count+=d[i];
                if (count+17>size || strlen(expected)!=2*(count+16)) return -1;
                for (i=0;i<count+16;i++)
                    if (d[1+i]!=(nibble(expected[2*i])*16+nibble(expected[2*i+1]))) return -1;
                huff_mask|=1u<<idx; d+=count+17; size-=count+17;
            }
        } else if (marker==0xc0) {
            unsigned w,h;
            if (sof || size!=15 || d[0]!=8 || d[5]!=3) return -1;
            h=be16(d+1); w=be16(d+3);
            if (!w || !h || w>2040 || h>2040 || w%8 || h%8) return -1;
            if (d[6]!=1 || (d[7]!=0x21 && d[7]!=0x22) || d[8]!=0 ||
                d[9]!=2 || d[10]!=0x11 || d[11]!=1 || d[12]!=3 || d[13]!=0x11 || d[14]!=1) return -1;
            out->width8=(uint8_t)(w/8); out->height8=(uint8_t)(h/8);
            out->type=d[7]==0x22 ? 1 : 0; sof=1;
        } else if (marker==0xda) {
            static const uint8_t sos[]={3,1,0,2,0x11,3,0x11,0,63,0};
            size_t end=pos;
            if (!sof || quant_mask!=3 || huff_mask!=15 || size!=sizeof(sos) || memcmp(d,sos,size)) return -1;
            while (end+1<n) {
                if (p[end]!=255) { ++end; continue; }
                if (p[end+1]==0) { end+=2; continue; }
                if (p[end+1]!=0xd9 || end==pos) return -1; /* No restart/progressive/multiple scans. */
                out->scan=p+pos; out->length=end-pos; return 0; /* SDK may append its 5-byte trailer. */
            }
            return -1;
        } else if (!((marker>=0xe0 && marker<=0xef) || marker==0xfe)) return -1;
    }
    return -1;
}

int rtp_jpeg_send(const jpeg_view *v, uint32_t timestamp, uint32_t ssrc,
                  uint16_t *seq, uint8_t channel, rtp_write_fn wr, void *ctx)
{
    uint8_t packet[1400];
    size_t offset=0;
    if (!v || !v->scan || !v->length || v->length>JPEG_FRAME_LIMIT || !seq || !wr) return -1;
    while (offset<v->length) {
        size_t header=24, chunk;
        memset(packet,0,24);
        packet[0]='$'; packet[1]=channel;
        packet[4]=0x80; packet[5]=26;
        put16(packet+6,*seq); put32(packet+8,timestamp); put32(packet+12,ssrc);
        packet[17]=(uint8_t)(offset>>16); packet[18]=(uint8_t)(offset>>8); packet[19]=(uint8_t)offset;
        packet[20]=v->type; packet[21]=255; packet[22]=v->width8; packet[23]=v->height8;
        if (!offset) { packet[24]=0; packet[25]=0; put16(packet+26,128); memcpy(packet+28,v->quant,128); header=156; }
        chunk=v->length-offset;
        if (chunk>sizeof(packet)-header) chunk=sizeof(packet)-header;
        if (offset+chunk==v->length) packet[5]|=0x80;
        memcpy(packet+header,v->scan+offset,chunk); put16(packet+2,(unsigned)(header+chunk-4));
        if (wr(ctx,packet,header+chunk)) return -1;
        ++*seq; offset+=chunk;
    }
    return 0;
}

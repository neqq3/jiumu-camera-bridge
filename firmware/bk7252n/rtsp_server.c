/* SPDX-License-Identifier: Apache-2.0 */
#include "rtsp_server.h"
#include "rtp_jpeg.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef RESEARCH_HOST
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <time.h>
static uint32_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint32_t)((uint64_t)t.tv_sec*1000+t.tv_nsec/1000000); }
#define alloc malloc
#define release free
#else
#include "include.h"
#include "rtos_pub.h"
#include "mem_pub.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
static uint32_t now_ms(void) { return rtos_get_time(); }
#define alloc os_malloc
#define release os_free
#endif

typedef struct { int fd; uint32_t start; } writer;
static int ready(int fd, int writing, unsigned ms)
{
    fd_set fds;
    struct timeval tv;
    FD_ZERO(&fds); FD_SET(fd,&fds);
    tv.tv_sec=(long)(ms/1000); tv.tv_usec=(long)(ms%1000)*1000;
    return select(fd+1,writing?NULL:&fds,writing?&fds:NULL,NULL,&tv);
}
static int send_bytes(void *opaque, const uint8_t *data, size_t n)
{
    writer *w=opaque;
    while (n) {
        int sent;
        if (now_ms()-w->start>2000 || ready(w->fd,1,100)<=0) return -1;
        /* Socket is nonblocking; select alone does not bound a blocking send. */
        sent=send(w->fd,data,n,0);
        if (sent<=0) return -1;
        data+=sent; n-=(size_t)sent;
    }
    return 0;
}
static int ascii_key(const char *a, const char *b)
{
    while (*a && *b) {
        unsigned x=(unsigned char)*a++, y=(unsigned char)*b++;
        if (x>='A' && x<='Z') x+='a'-'A';
        if (x!=y) return 0;
    }
    return !*a && !*b;
}
static int decimal(const char *s, unsigned *out)
{
    unsigned v=0;
    if (!*s) return -1;
    for (;*s;s++) {
        if (*s<'0' || *s>'9' || v>10000000) return -1;
        v=v*10+(unsigned)(*s-'0');
    }
    *out=v; return 0;
}
static int reply(int fd, unsigned cseq, int code, const char *reason, const char *extra, const char *body)
{
    char buf[1200];
    int n=snprintf(buf,sizeof(buf),"RTSP/1.0 %d %s\r\nCSeq: %u\r\n%sContent-Length: %u\r\n\r\n%s",
                   code,reason,cseq,extra,(unsigned)strlen(body),body);
    writer w={fd,now_ms()};
    if (n<0 || (size_t)n>=sizeof(buf)) return -1;
    return send_bytes(&w,(const uint8_t *)buf,(size_t)n);
}

/* One bounded session. TCP interleaving only; no outgoing connections or DNS. */
static void client(int fd, uint32_t id, rtsp_frame_fn get_frame, void *ctx, uint8_t *frame)
{
    char input[2048], session[20];
    size_t used=0;
    unsigned configured=0, playing=0;
    uint16_t seq=(uint16_t)id;
    uint32_t last_input=now_ms(), last_frame=last_input, next_frame=last_input, request_started=last_input;
    snprintf(session,sizeof(session),"%08x",(unsigned)id);
    for (;;) {
        uint32_t now=now_ms();
        if (now-last_input>30000 || (used && now-request_started>5000) || (playing && now-last_frame>5000)) return;
        if (ready(fd,0,playing?10:100)>0) {
            int count=recv(fd,input+used,sizeof(input)-1-used,0);
            if (count<=0) return;
            if (!used) request_started=now;
            used+=(size_t)count; input[used]=0; last_input=now;
        }
        while (used) {
            char *end, *line, *next, *transport=NULL, *session_in=NULL;
            char method[24], uri[256], version[16], junk;
            unsigned cseq=0, seen_cseq=0, length=0, seen_length=0;
            size_t consumed;
            int bad=0, rc=0;
            if (input[0]=='$') {
                size_t size;
                if (used<4) break;
                size=((unsigned char)input[2]*256u)+(unsigned char)input[3];
                if (input[1]!=1 || size>1024) return;
                if (used<size+4) break;
                memmove(input,input+size+4,used-size-4); used-=size+4; input[used]=0; request_started=now_ms(); continue;
            }
            end=strstr(input,"\r\n\r\n");
            if (!end) { if (memchr(input,0,used) || used==sizeof(input)-1) return; break; }
            consumed=(size_t)(end-input)+4;
            if (memchr(input,0,consumed)) return;
            line=strstr(input,"\r\n");
            if (!line) return;
            *line=0;
            if (sscanf(input,"%23s %255s %15s %c",method,uri,version,&junk)!=3 || strcmp(version,"RTSP/1.0")) return;
            line+=2;
            while (line<end) {
                char *colon;
                next=strstr(line,"\r\n"); if (!next) return;
                *next=0; colon=strchr(line,':');
                if (!colon) return;
                *colon++=0; while (*colon==' ') ++colon;
                if (ascii_key(line,"cseq")) { if (seen_cseq++ || decimal(colon,&cseq)) bad=1; }
                if (ascii_key(line,"content-length")) { if (seen_length++ || decimal(colon,&length)) bad=1; }
                if (ascii_key(line,"transport")) { if (transport) bad=1; transport=colon; }
                if (ascii_key(line,"session")) { if (session_in) bad=1; session_in=colon; }
                line=next+2;
            }
            if (bad || !seen_cseq || length) { reply(fd,cseq,400,"Bad Request","",""); return; }
            if (strcmp(method,"OPTIONS")==0)
                rc=reply(fd,cseq,200,"OK","Public: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN\r\n","");
            else if (strcmp(method,"DESCRIBE")==0) {
                const char *sdp="v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=BK7252N research\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 26\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:26 JPEG/90000\r\na=control:track0\r\n";
                char extra[360];
                if (strchr(uri,'\r') || strchr(uri,'\n') || strncmp(uri,"rtsp://",7)) return;
                snprintf(extra,sizeof(extra),"Content-Type: application/sdp\r\nContent-Base: %s/\r\n",uri);
                rc=reply(fd,cseq,200,"OK",extra,sdp);
            } else if (strcmp(method,"SETUP")==0) {
                if (configured) rc=reply(fd,cseq,455,"Method Not Valid in This State","","");
                else if (!transport || strcmp(transport,"RTP/AVP/TCP;unicast;interleaved=0-1"))
                    rc=reply(fd,cseq,461,"Unsupported Transport","","");
                else {
                    char extra[180]; configured=1;
                    snprintf(extra,sizeof(extra),"Session: %s;timeout=30\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n",session);
                    rc=reply(fd,cseq,200,"OK",extra,"");
                }
            } else if (!configured || !session_in || strcmp(session_in,session))
                rc=reply(fd,cseq,454,"Session Not Found","","");
            else {
                char extra[80]; snprintf(extra,sizeof(extra),"Session: %s\r\n",session);
                if (!strcmp(method,"PLAY")) { playing=1; last_frame=next_frame=now_ms(); rc=reply(fd,cseq,200,"OK",extra,""); }
                else if (!strcmp(method,"GET_PARAMETER")) rc=reply(fd,cseq,200,"OK",extra,"");
                else if (!strcmp(method,"TEARDOWN")) { reply(fd,cseq,200,"OK",extra,""); return; }
                else rc=reply(fd,cseq,405,"Method Not Allowed","","");
            }
            if (rc) return;
            memmove(input,input+consumed,used-consumed); used-=consumed; input[used]=0;
            request_started=now_ms();
        }
        if (playing && (int32_t)(now_ms()-next_frame)>=0) {
            jpeg_view view;
            size_t n=get_frame(ctx,frame,JPEG_FRAME_LIMIT);
            now=now_ms(); next_frame=now+100;
            if (n && !jpeg_parse(frame,n,&view)) {
                writer w={fd,now};
                if (rtp_jpeg_send(&view,now*90,id,&seq,0,send_bytes,&w)) return;
                last_frame=now_ms();
            }
        }
    }
}

int research_rtsp_serve(const char *bind_ip, unsigned port, rtsp_frame_fn frame, void *ctx)
{
    int listener, one=1;
    struct sockaddr_in addr;
    uint32_t id=now_ms()|1u;
    uint8_t *buffer;
    if (!frame || !port || port>65535) return -1;
    buffer=alloc(JPEG_FRAME_LIMIT); if (!buffer) return -1;
    listener=socket(AF_INET,SOCK_STREAM,0);
    if (listener<0) { release(buffer); return -1; }
    memset(&addr,0,sizeof(addr)); addr.sin_family=AF_INET; addr.sin_port=htons((uint16_t)port);
    addr.sin_addr.s_addr=inet_addr(bind_ip);
    setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one));
    if (bind(listener,(struct sockaddr *)&addr,sizeof(addr)) || listen(listener,1)) { close(listener); release(buffer); return -1; }
    for (;;) {
        int fd=accept(listener,NULL,NULL);
        if (fd<0) break;
        if (ioctl(fd,FIONBIO,&one)==0) client(fd,++id,frame,ctx,buffer);
        close(fd);
    }
    close(listener); release(buffer); return -1;
}

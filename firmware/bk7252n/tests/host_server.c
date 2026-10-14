/* SPDX-License-Identifier: Apache-2.0 */
#include "rtsp_server.h"
#include "rtp_jpeg.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
static uint8_t fixture[JPEG_FRAME_LIMIT];
static size_t fixture_size;
static size_t frame(void *ctx,uint8_t *out,size_t cap)
{
    (void)ctx;
    if (cap<fixture_size) return 0;
    memcpy(out,fixture,fixture_size); return fixture_size;
}
int main(int argc,char **argv)
{
    FILE *f;
    jpeg_view v;
    if (argc!=2) return 2;
    f=fopen(argv[1],"rb"); if (!f) return 2;
    fixture_size=fread(fixture,1,sizeof(fixture),f); fclose(f);
    if (jpeg_parse(fixture,fixture_size,&v)) { fputs("fixture rejected\n",stderr); return 3; }
    signal(SIGPIPE,SIG_IGN);
    puts("fixture accepted; starting loopback RTSP"); fflush(stdout);
    return research_rtsp_serve("127.0.0.1",18554,frame,NULL);
}

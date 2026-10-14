/* SPDX-License-Identifier: Apache-2.0 */
#include "include.h"
#include "rtos_pub.h"
#include "uart_pub.h"
#include "video_transfer.h"
#include "rtsp_server.h"

static size_t camera_frame(void *ctx, uint8_t *buffer, size_t capacity)
{
    static int opened;
    int error=0;
    UINT32 count;
    (void)ctx;
    if (!opened) {
        tvideo_set_sensor(VGA_640_480,TYPE_30FPS);
        if (video_buffer_open()<0) return 0;
        opened=1;
    }
    count=video_buffer_read_frame(buffer,(UINT32)capacity,&error,200);
    return error==0 ? count : 0;
}
static void rtsp_task(void *arg)
{
    (void)arg;
    /* Deliberately loopback until board and authentication gates are met.
     * No Wi-Fi credentials, cloud endpoints, OTA client or flash writer here. */
    research_rtsp_serve("127.0.0.1",8554,camera_frame,NULL);
    rtos_delete_thread(NULL);
}
void user_main(void)
{
    /* SDK invokes this after extended_app_waiting_for_launch(). */
    if (rtos_create_thread(NULL,5,"native_rtsp",rtsp_task,8192,NULL)!=0)
        os_printf("native RTSP task creation failed\r\n");
}

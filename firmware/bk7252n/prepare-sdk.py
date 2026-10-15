"""Small, explicit standalone-build overlay for the pinned OpenBeken SDK fork.

No vendor firmware is read and no upgrade or hardware operation is performed.
"""
from pathlib import Path
import shutil
import re

sdk = Path('sdk')
source = Path(__file__).resolve().parent
makefile = sdk / 'application.mk'
text = makefile.read_text()
marker = '-include ../../platforms/BK723x/OpenBeken.mk'
assert text.count(marker) == 1
text = text.replace(marker, '''# Standalone research overlay (not the OpenBeken application).
SRC_C += ./fixes/blank.c
SRC_C += ./beken378/app/video_work/video_buffer.c
APP_C += ./research-hostname.c
APP_C += ./research/sp0a39.c ./research/rtp_jpeg.c ./research/rtsp_server.c ./research/research-app.c
APP_C += ./research/maintenance_core.c ./research/maintenance_http.c ./research/maintenance_sdk.c
INCLUDES += -I./research
# Keep libc entry points needed by LTO-generated calls.
LFLAGS += -Wl,-u,strchr -Wl,-u,strcpy
# Require the real SDK camera/frame implementations in the linked image.
LFLAGS += -Wl,-u,video_buffer_open -Wl,-u,video_buffer_read_frame -Wl,-u,video_buffer_close
LFLAGS += -Wl,-u,research_rtsp_serve -Wl,-u,sp0a39_init_candidate -Wl,-u,jpeg_parse -Wl,-u,rtp_jpeg_send -Wl,-u,user_main
LFLAGS += -Wl,-u,maintenance_sdk_probe -Wl,-u,maintenance_sdk_accept_contract -Wl,-u,maintenance_sdk_backup_read -Wl,-u,maintenance_sdk_serve -Wl,-u,maintenance_sdk_task
LFLAGS += -Wl,-u,maintenance_sdk_reboot_ready -Wl,-u,maintenance_sdk_reboot
LFLAGS += -Wl,-u,maintenance_http_serve -Wl,-u,mc_init -Wl,-u,mc_begin -Wl,-u,mc_feed -Wl,-u,mc_finish -Wl,-u,mc_commit -Wl,-u,mc_abort
''')
makefile.write_text(text)
shutil.copyfile(source / 'research-hostname.c', sdk / 'research-hostname.c')
research = sdk / 'research'
research.mkdir(exist_ok=True)
for name in ['sp0a39.c', 'sp0a39.h', 'rtp_jpeg.c', 'rtp_jpeg.h', 'rtsp_server.c', 'rtsp_server.h', 'research-app.c',
             'maintenance_core.c', 'maintenance_core.h', 'maintenance_http.c', 'maintenance_http.h',
             'maintenance_sdk.c', 'maintenance_sdk.h']:
    shutil.copyfile(source/name, research/name)
shutil.copytree(source/'third_party', research/'third_party', dirs_exist_ok=True)

# CMD_FLASH_GET_SIZE reports the driver's selected configuration. Its unknown
# chip fallback is 4 MiB, NOT a physical capacity measurement. Generate an exact
# allowlist from this pinned driver's data; exclude the all-zero fallback ID.
driver = (sdk/'beken378/driver/flash/flash.c').read_text()
table = driver.split('static const flash_config_t flash_config[] =', 1)[1].split('};', 1)[0]
chips = {}
for identity, capacity in re.findall(r'\{\s*(0x[0-9a-fA-F]+)\s*,\s*\d+\s*,\s*(0x[0-9a-fA-F]+)', table):
    identity, capacity = int(identity, 16), int(capacity, 16)
    if identity == 0:
        continue
    assert identity not in chips or chips[identity] == capacity
    assert capacity in (0x100000, 0x200000, 0x400000, 0x800000)
    chips[identity] = capacity
assert len(chips) >= 20, 'pinned flash configuration table changed'
(research/'maintenance_flash_chips.h').write_text(
    '/* Generated from the pinned SDK flash_config; no device identifiers. */\n'
    'static const struct { uint32_t id; uint32_t bytes; } maintenance_known_chips[] = {\n' +
    ''.join(f'    {{0x{identity:06x}u, 0x{capacity:x}u}},\n' for identity, capacity in sorted(chips.items())) +
    '};\n')

config = sdk/'beken378/app/config/sys_config_bk7252n.h'
text = config.read_text()
text, count = re.subn(r'(#define USE_CAMERA\s+)GC0310_DEV', r'\1SP0A39_DEV', text)
assert count == 1
# Disable the SDK's unauthenticated HTTP OTA downloader. Our maintenance path
# requires locally provisioned authentication and a verified loader contract.
text, count = re.subn(r'(#define CFG_SUPPORT_OTA_HTTP\s+)1', r'\g<1>0', text)
assert count == 1
config.write_text(text)

camera_dir = sdk/'beken378/func/camera_intf'
config = camera_dir/'camera_intf_config.h'
text = config.read_text()
text = text.replace('#define GC0310_DEV ', '#define SP0A39_DEV (0xABC09)\n#define GC0310_DEV ', 1)
config.write_text(text)
camera = camera_dir/'camera_intf.c'
text = camera.read_text()
text = text.replace('#include "camera_intf.h"', '#include "camera_intf.h"\n#include "sp0a39.h"', 1)
marker = '    #if (USE_CAMERA == PAS6329_DEV)'
assert text.count(marker) == 1
text = text.replace(marker, '''    #if (USE_CAMERA == SP0A39_DEV)
    i2c_operater.salve_id = SP0A39_ADDRESS;
    if (CMPARAM_GET_PPI(ejpeg_cfg.sener_cfg) != VGA_640_480) return -1;
    ret = sp0a39_init_candidate(camera_intf_sccb_read, camera_intf_sccb_write);
    goto config_exit;
    #elif (USE_CAMERA == PAS6329_DEV)''')
# Generic SDK flip writes a different sensor's register without checking ID.
text = text.replace('void camera_flip(UINT8 n)\n{', '''void camera_flip(UINT8 n)
{
    #if (USE_CAMERA == SP0A39_DEV)
    (void)n;
    return;
    #endif''')
camera.write_text(text)

# Upstream calculates frame_len-7 before checking length. Reject short DMA
# frames rather than constructing a pointer before the caller's buffer.
buffer = sdk/'beken378/app/video_work/video_buffer.c'
text = buffer.read_text()
needle = '                    sof_ptr = g_vbuf->buf_base;'
assert text.count(needle) == 1
text = text.replace(needle, '''                    if (g_vbuf->frame_len < 7) {
                        GLOBAL_INT_DISABLE();
                        g_vbuf->start_buf = BUF_STA_ERR;
                        GLOBAL_INT_RESTORE();
                        rtos_set_semaphore(&g_vbuf->aready_semaphore);
                        return len;
                    }
''' + needle)
buffer.write_text(text)

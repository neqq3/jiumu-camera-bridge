"""Small, explicit standalone-build overlay for the pinned OpenBeken SDK fork.

No vendor firmware is read and no upgrade or hardware operation is performed.
"""
from pathlib import Path
import shutil

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
# Keep libc entry points needed by LTO-generated calls.
LFLAGS += -Wl,-u,strchr -Wl,-u,strcpy
# Require the real SDK camera/frame implementations in the linked image.
LFLAGS += -Wl,-u,video_buffer_open -Wl,-u,video_buffer_read_frame -Wl,-u,video_buffer_close
''')
makefile.write_text(text)
shutil.copyfile(source / 'research-hostname.c', sdk / 'research-hostname.c')

# SP0A39 candidate adapter

This is a compiled research adapter, not a board-tested driver. It probes
page 0 registers 0x00/0x01 for ID 0x0a39 at SCCB address 0x21, and stops on
an unexpected ID or any failed bus operation. The SDK bounds SCCB retries.
RESET/PWDN GPIOs remain unknown and are not toggled by this adapter.

`third_party/sp0a39-dvp-gray.h` is unmodified Espressif Apache-2.0 source:
[fixed upstream revision](https://github.com/espressif/esp-video-components/blob/ee31057dcf3c652284959283780f591e3d6320f2/esp_cam_sensor/sensors/sp0a39/private_include/sp0a39_dvp_8bit_24Minput_gray_640x480_30fps.h).
SHA-256: cae19833df213c78fb2227051afe960b0e52f81a1bdbf4f0feb2849311c48383.
Its copyright notice and license are retained. The proprietary original table
is not included in this repository or uploaded to Actions.

The public DVP profile is 24 MHz, VGA, grayscale. The candidate applies a small
separate color delta: page 1 register 0x32=0x15 and page 2 0x26/0x27=0xcb/0xc2
match both the original firmware and the public SPI color profile. Page 1
0x35=0x10 and page 0 0x32=0x02 match the original. Page 0 0x31=0x00 is inferred
from the public color profile (the original leaves that register implicit).
These observations do **not** prove the combined table's timing, pixel byte
order, or image quality. The public DVP clock selection is retained; SPI
transport settings are never applied. The SDK JPEG input is YUYV; an actual
captured frame is still required to validate the byte order.

Only VGA is accepted. The sensor profile targets 30 fps; RTSP delivery is
initially capped at 10 fps. CI verifies bus errors and wrong-ID behavior, not
sensor electrical compatibility. Power, reset, frame timing and color remain
hardware gates before any separately authorized trial.

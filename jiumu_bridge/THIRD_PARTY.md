<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Third-party components

This source repository does not distribute the vendor APK, native SDK, firmware,
decompiler output, REA, or A9_PPPP source. Application code uses Node built-ins.

Runtime builds obtain these separate components:

- [Node.js](https://github.com/nodejs/node/blob/main/LICENSE): Node's license and
  bundled third-party notices apply to the base image/runtime.
- [go2rtc v1.9.14](https://github.com/AlexxIT/go2rtc/tree/v1.9.14): MIT, copyright
  2022 Alexey Khit. License text is included in `licenses/go2rtc-MIT.txt`.
- [FFmpeg](https://ffmpeg.org/legal.html): the Debian package's actual enabled
  components determine LGPL/GPL obligations. Preserve package copyright files
  and satisfy corresponding-source requirements when distributing images.

Private development images are built in GitHub Actions. The workflow records
actual binary/source package versions, runtime build options and license texts.
Before external distribution, corresponding sources and notices must also be
retained and made available for that release; short-lived CI artifacts are not
a replacement. The bridge's Apache-2.0 license does not
replace the licenses of FFmpeg, Node, go2rtc or their dependencies.

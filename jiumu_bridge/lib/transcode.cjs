// SPDX-License-Identifier: Apache-2.0
'use strict';
// Multipart JPEG has no source presentation timestamps. Camera delivery varies
// with exposure and reconnects; assigning an input frame rate compresses time.
// Stamp decoded arrivals before producing the fixed-rate output; resampling can
// repeat frames between arrivals. Camera loss remains subject to the session
// watchdog and HTTP read timeout, independent of this output timing.
const videoInput='-rw_timeout 8000000 -use_wallclock_as_timestamps 1 -f mpjpeg -analyzeduration 0 -probesize 32 -i {input}';
const videoFilter='setpts=(RTCTIME-RTCSTART)/(TB*1000000),fps=10,setsar=1';
const audioInput='-rw_timeout 8000000 -analyzeduration 1 -probesize 32 -i {input}';
module.exports={videoInput,videoFilter,audioInput};

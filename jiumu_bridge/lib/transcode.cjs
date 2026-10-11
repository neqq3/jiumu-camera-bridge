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
// A restream can retain its downstream socket when an upstream encoder restarts
// with a new RTP clock. Stamp packet arrivals to avoid fps-filter frame bursts.
// Validated with Frigate 0.18 / FFmpeg 7; these are RTSP input options.
const frigateInputArgs=Object.freeze(['-rtsp_transport','tcp','-timeout','10000000','-use_wallclock_as_timestamps','1']);
function mediaSources(base) {
  // Fixed internal endpoints only: this string is parsed as an exec command.
  if(!/^http:\/\/127\.0\.0\.1:\d+\/cameras\/[a-z0-9_]+$/.test(base))throw Error('Invalid internal media endpoint');
  // One SDP advertises both tracks. Separate producers may let a reconnecting
  // restream cache video-only SDP while audio is still starting, permanently
  // losing audio even after the camera recovers. A missing input must fail the
  // whole producer so the next attempt negotiates both tracks together.
  return [`exec:ffmpeg -hide_banner -v error ${videoInput.replace('{input}',base+'/stream.mjpeg')} ${audioInput.replace('{input}',base+'/audio.wav')} -map 0:v:0 -map 1:a:0 -vf ${videoFilter} -c:v libx264 -preset ultrafast -tune zerolatency -threads:v 2 -g:v 20 -pix_fmt yuv420p -c:a aac -f rtsp -rtsp_transport tcp {output}`];
}
module.exports={videoInput,videoFilter,audioInput,frigateInputArgs,mediaSources};

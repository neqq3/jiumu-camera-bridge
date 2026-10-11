// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {frigateInputArgs}=require('../jiumu_bridge/lib/transcode.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('independently restarting RTSP audio/video keep recording tracks near the same origin',{timeout:35000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-record-clock-'));let go,record;
  try {
    const config={api:{listen:'127.0.0.1:18986'},rtsp:{listen:'127.0.0.1:18956'},webrtc:{listen:''},log:{level:'error'},streams:{synthetic:[
      'exec:ffmpeg -hide_banner -v error -re -f lavfi -i testsrc2=size=160x120:rate=10 -t 7 -c:v libx264 -threads 1 -g 10 -preset ultrafast -tune zerolatency -an -rtsp_transport tcp -f rtsp {output}',
      'exec:ffmpeg -hide_banner -v error -re -f lavfi -i sine=frequency=440:sample_rate=8000 -t 9 -c:a aac -vn -rtsp_transport tcp -f rtsp {output}']}};
    const configPath=path.join(dir,'go2rtc.json');fs.writeFileSync(configPath,JSON.stringify(config));
    go=spawn(process.env.GO2RTC_BIN||'/usr/local/bin/go2rtc',['-config',configPath],{stdio:'ignore'});
    let startupError;go.on('error',error=>startupError=error);let ready=false;
    for(let i=0;i<40&&!ready;i++){
      if(startupError)throw startupError;
      try{const r=await fetch('http://127.0.0.1:18986/api',{signal:AbortSignal.timeout(200)});ready=r.ok;}catch{}
      if(!ready)await delay(100);
    }
    assert.ok(ready,'go2rtc did not start');
    record=spawn('ffmpeg',['-v','error',...frigateInputArgs,'-i','rtsp://127.0.0.1:18956/synthetic',
      '-map','0:v:0','-map','0:a:0','-c','copy','-f','segment','-segment_time','5','-reset_timestamps','1',path.join(dir,'segment-%02d.mp4')],{stdio:['ignore','ignore','pipe']});
    let closed=false,code,childError;record.on('error',e=>childError=e);record.stderr.resume();
    const done=new Promise(resolve=>record.once('close',c=>{closed=true;code=c;resolve();}));
    await delay(25000);assert.ifError(childError);assert.equal(closed,false,'recorder stopped early');
    record.kill('SIGINT');await Promise.race([done,delay(1500).then(()=>{if(!closed)throw Error('recorder did not exit');})]);
    assert.ok([0,255].includes(code));
    const files=fs.readdirSync(dir).filter(name=>name.endsWith('.mp4')).sort();assert.ok(files.length>=4);
    // Ignore only the final deliberately truncated segment.
    for(const file of files.slice(0,-1)){
      const result=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,start_time,duration:format=duration','-of','json',path.join(dir,file)],{timeout:3000});
      assert.equal(result.status,0,'segment must be readable');const probe=JSON.parse(result.stdout);
      const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio');
      assert.ok(video&&audio,'both tracks required');
      assert.ok(Math.abs(Number(video.start_time)-Number(audio.start_time))<1.5,'audio/video origins diverged after reconnect');
      assert.ok(Number(probe.format.duration)>0&&Number(probe.format.duration)<9,`invalid container duration: ${probe.format.duration}`);
    }
  } finally {record?.kill('SIGKILL');go?.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
});

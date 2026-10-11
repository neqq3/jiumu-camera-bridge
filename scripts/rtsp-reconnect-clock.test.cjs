// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {frigateInputArgs}=require('../jiumu_bridge/lib/transcode.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Frigate input preserves elapsed time across repeated upstream RTSP restarts',{timeout:35000},async()=>{
  // Run in an isolated network namespace: loopback only, no camera or secrets.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-rtsp-clock-'));
  let go,consumer;
  try {
    const config={api:{listen:'127.0.0.1:18984'},rtsp:{listen:'127.0.0.1:18954'},webrtc:{listen:''},log:{level:'error'},
      streams:{synthetic:'exec:ffmpeg -hide_banner -v error -re -f lavfi -i testsrc2=size=160x120:rate=10 -t 7 -c:v libx264 -threads 1 -g 10 -preset ultrafast -tune zerolatency -an -rtsp_transport tcp -f rtsp {output}'}};
    const configPath=path.join(dir,'go2rtc.json');fs.writeFileSync(configPath,JSON.stringify(config));
    go=spawn(process.env.GO2RTC_BIN||'/usr/local/bin/go2rtc',['-config',configPath],{stdio:'ignore'});
    let startupError;go.on('error',error=>startupError=error);
    let ready=false;
    for(let i=0;i<40&&!ready;i++){
      if(startupError)throw startupError;
      try{const r=await fetch('http://127.0.0.1:18984/api',{signal:AbortSignal.timeout(200)});ready=r.ok;}catch{}
      if(!ready)await delay(100);
    }
    assert.ok(ready,'go2rtc did not start');
    const progress=[];let pending='',values={},exited=false,exitCode=null,childError;
    const start=Date.now();
    consumer=spawn('ffmpeg',['-hide_banner','-v','error',...frigateInputArgs,'-i','rtsp://127.0.0.1:18954/synthetic',
      '-vf','fps=5','-threads','1','-frames:v','200','-progress','pipe:1','-f','null','-']);
    const closed=new Promise(resolve=>consumer.once('close',code=>{exited=true;exitCode=code;resolve();}));
    consumer.on('error',error=>childError=error);consumer.stderr.resume();
    consumer.stdout.on('data',b=>{
      pending+=b;let i;
      while((i=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,i);pending=pending.slice(i+1);const keyEnd=line.indexOf('=');
        values[line.slice(0,keyEnd)]=line.slice(keyEnd+1);
        if(line.startsWith('progress=')){progress.push({seconds:(Date.now()-start)/1000,frames:Number(values.frame),outputSeconds:Number(values.out_time_us)/1e6});values={};}
      }
    });
    await delay(25000);
    assert.ifError(childError);assert.equal(exited,false,'consumer exited before observation ended');
    consumer.kill('SIGINT');
    await Promise.race([closed,delay(2000).then(()=>{if(!exited)throw Error('FFmpeg did not exit');})]);
    assert.ok([0,255].includes(exitCode),'unexpected FFmpeg termination');
    assert.ok(progress.length>=20,'too little progress to cover upstream restarts');
    for(const point of progress){
      assert.ok(point.outputSeconds<=point.seconds+2,`output clock jumped: ${JSON.stringify(point)}`);
      assert.ok(point.frames<=point.seconds*5+10,'fps filter generated a frame burst');
    }
    const last=progress.at(-1);
    assert.ok(last.outputSeconds>=22&&last.outputSeconds<=27,`clock stalled or jumped: ${JSON.stringify(last)}`);
  } finally {
    consumer?.kill('SIGKILL');go?.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});
  }
});

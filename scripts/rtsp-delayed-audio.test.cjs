// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {mediaSources,frigateInputArgs,videoInput,videoFilter,audioInput}=require('../jiumu_bridge/lib/transcode.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('late audio and a camera outage cannot leave a restream permanently video-only',{timeout:85000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-late-audio-'));
  const clients=new Map();let go,record,tick,server,stopped=false,attempt=0;
  const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120','-frames:v','1','-threads','1','-f','image2pipe','-c:v','mjpeg','pipe:1'],{timeout:5000});
  assert.equal(generated.status,0);const jpeg=generated.stdout;
  const header=Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  const wav=Buffer.alloc(44);wav.write('RIFF');wav.writeUInt32LE(0xffffffff,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(0xffffffff,40);
  const started=Date.now(),elapsed=()=>Date.now()-started;
  const available=audio=>!(elapsed()>=24000&&elapsed()<35000)&&(!audio||elapsed()>=8000&&!(elapsed()>=24000&&elapsed()<39000));
  try {
    server=http.createServer((req,res)=>{
      const audio=req.url.endsWith('/audio.wav');
      if(!available(audio)){res.writeHead(503);res.end();return;}
      res.writeHead(200,{'Content-Type':audio?'audio/wav':'multipart/x-mixed-replace; boundary=frame'});
      if(audio)res.write(wav);clients.set(res,audio);res.once('close',()=>clients.delete(res));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    tick=setInterval(()=>{for(const [res,audio]of clients){if(!available(audio)){res.destroy();continue;}res.write(audio?Buffer.alloc(1600):Buffer.concat([header,jpeg,Buffer.from('\r\n')]));}},100);
    const base=`http://127.0.0.1:${server.address().port}/cameras/synthetic`;
    const sources=process.env.TEST_OLD_SPLIT==='1'?[`ffmpeg:${base}/stream.mjpeg#input=jiumu#video=h264#raw=-vf ${videoFilter} -threads:v 2 -g:v 20`,`ffmpeg:${base}/audio.wav#input=jiumu_audio#audio=aac#audio=opus`]:mediaSources(base);
    const cfg=path.join(dir,'go.json');fs.writeFileSync(cfg,JSON.stringify({api:{listen:'127.0.0.1:18989'},rtsp:{listen:'127.0.0.1:18959'},webrtc:{listen:''},log:{level:'error'},ffmpeg:{jiumu:videoInput,jiumu_audio:audioInput},streams:{source:sources,restream:'rtsp://127.0.0.1:18959/source'}}));
    go=spawn(process.env.GO2RTC_BIN||'/usr/local/bin/go2rtc',['-config',cfg],{stdio:['ignore','ignore','ignore']});
    let goError;go.on('error',e=>goError=e);
    for(let i=0;i<50;i++){assert.ifError(goError);try{if((await fetch('http://127.0.0.1:18989/api',{signal:AbortSignal.timeout(200)})).ok)break;}catch{}await delay(100);}
    function startRecorder(){
      if(stopped)return;attempt++;
      record=spawn('ffmpeg',['-v','error',...frigateInputArgs,'-i','rtsp://127.0.0.1:18959/restream','-c','copy','-f','segment','-segment_time','5','-reset_timestamps','1',path.join(dir,`attempt-${attempt}-%03d.mp4`)],{stdio:'ignore'});
      record.once('close',()=>{if(!stopped)setTimeout(startRecorder,1000).unref();});
    }
    startRecorder();await delay(Math.max(0,67000-elapsed()));stopped=true;
    if(record&&record.exitCode===null){record.kill('SIGINT');await Promise.race([once(record,'close'),delay(2000)]);}
    const reports=[];
    for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.mp4'))){
      const file=path.join(dir,name),mtime=fs.statSync(file).mtimeMs-started;
      if(!(mtime>18000&&mtime<24000||mtime>52000&&mtime<65000))continue;
      const r=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,start_time,duration:format=duration','-of','json',file],{timeout:3000});
      assert.equal(r.status,0);const p=JSON.parse(r.stdout),v=p.streams.find(s=>s.codec_type==='video'),a=p.streams.find(s=>s.codec_type==='audio');
      assert.ok(v&&a,`both tracks required after recovery: ${name}`);
      assert.ok(Math.abs(Number(v.start_time)-Number(a.start_time))<1.5,'recovered track origins');
      assert.ok(Number(p.format.duration)<10,'recovered segment duration');reports.push({mtime});
    }
    assert.ok(reports.some(r=>r.mtime<24000),'initial delayed-audio recovery recorded');
    assert.ok(reports.some(r=>r.mtime>52000),'post-outage recovery recorded');
  }finally{
    stopped=true;clearInterval(tick);record?.kill('SIGKILL');go?.kill('SIGKILL');for(const r of clients.keys())r.destroy();server?.closeAllConnections();server?.close();fs.rmSync(dir,{recursive:true,force:true});
  }
});

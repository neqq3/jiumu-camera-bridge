// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {EventEmitter,once}=require('node:events'),{spawn,spawnSync}=require('node:child_process');
// Synthetic device transport only; production CameraSession, HTTP, FFmpeg and
// two go2rtc layers are exercised without a camera or vendor connection.
class Client extends EventEmitter{constructor(){super();this.stats={};}start(){}controlStatus(){return {};}close(){if(!this.closed){this.closed=true;this.emit('closed');}}fail(reason){this.emit('failure',reason);this.close();}frame(type,body){this.emit('data',1,{type,body});}}
require('../jiumu_bridge/lib/hlp-client.cjs').HlpClient=Client;
require('../jiumu_bridge/lib/media.cjs').MediaParser=class{constructor(fn){this.fn=fn;}accept(x){this.fn(x.type,x.body,{});}reset(){}};
const {CameraSession}=require('../jiumu_bridge/lib/session.cjs');
const {mediaSources,frigateInputArgs,frigateRecordArgs}=require('../jiumu_bridge/lib/transcode.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('real media pipeline recovers after independent video and audio stalls',{timeout:92000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-session-media-'));
 let session,server,go,record,tick,stopped=false,attempt=0;const checkpoints=[],created=new Map();let recorderWarnings='';
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120','-frames:v','1','-threads','1','-f','image2pipe','-c:v','mjpeg','pipe:1'],{timeout:5000});assert.equal(generated.status,0);
 const jpeg=generated.stdout,started=Date.now(),elapsed=()=>Date.now()-started;
 const videoAvailable=()=>!(elapsed()>=18000&&elapsed()<27000);
 const audioAvailable=()=>elapsed()>=4000&&!(elapsed()>=47000&&elapsed()<56000);
 try{
  session=new CameraSession({id:'synthetic',config:{}});
  server=http.createServer((req,res)=>session.serve(res,req.url.endsWith('/audio.wav')?'audio.wav':'stream.mjpeg'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  tick=setInterval(()=>{if(videoAvailable())session.client.frame(3,jpeg);if(audioAvailable())session.client.frame(7,Buffer.alloc(800,0xd5));for(const name of fs.readdirSync(dir))if(name.endsWith('.mp4')&&!created.has(name))created.set(name,elapsed());},100);
  const base=`http://127.0.0.1:${server.address().port}/cameras/synthetic`,cfg=path.join(dir,'go.json');
  fs.writeFileSync(cfg,JSON.stringify({api:{listen:'127.0.0.1:18989'},rtsp:{listen:'127.0.0.1:18959'},webrtc:{listen:''},log:{level:'error'},streams:{source:mediaSources(base),restream:'rtsp://127.0.0.1:18959/source'}}));
  go=spawn(process.env.GO2RTC_BIN||'/usr/local/bin/go2rtc',['-config',cfg],{stdio:'ignore'});
  let goError;go.on('error',e=>goError=e);
  for(let i=0;i<50;i++){assert.ifError(goError);try{if((await fetch('http://127.0.0.1:18989/api',{signal:AbortSignal.timeout(200)})).ok)break;}catch{}await delay(100);}
  function startRecorder(){if(stopped)return;attempt++;
   const outputArgs=[...frigateRecordArgs];outputArgs[outputArgs.indexOf('-segment_time')+1]='4';outputArgs[outputArgs.indexOf('-strftime')+1]='0';
   record=spawn('ffmpeg',['-v','warning','-nostats',...frigateInputArgs,'-i','rtsp://127.0.0.1:18959/restream',...outputArgs,path.join(dir,`attempt-${attempt}-%03d.mp4`)],{stdio:['ignore','ignore','pipe']});
   record.stderr.on('data',b=>{if(recorderWarnings.length<1024*1024)recorderWarnings+=b.toString();});
   record.once('close',()=>{if(!stopped)setTimeout(startRecorder,500).unref();});}
  startRecorder();
  for(const at of [23000,52000]){await delay(Math.max(0,at-elapsed()));checkpoints.push(session.videoClients.size+session.audioClients.size);assert.equal(checkpoints.at(-1),0,'stale inputs closed before the 8-second FFmpeg timeout');}
  await delay(Math.max(0,78000-elapsed()));stopped=true;
  if(record&&record.exitCode===null){record.kill('SIGINT');await Promise.race([once(record,'close'),delay(2000)]);}
  const verified=[],boundaryErrors=[];
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.mp4'))){
   const file=path.join(dir,name),mtime=fs.statSync(file).mtimeMs-started,start=created.get(name);
   // A file completed after recovery can have STARTED during the outage.
   // Select by both boundaries; crossing segments are not recovery samples.
   const phase=start>6000&&mtime<17500?'initial':start>31000&&mtime<46500?'video':start>60000&&mtime<77500?'audio':null;
   if(mtime>=77500)continue;
   const result=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,start_time,duration,nb_frames:format=duration','-of','json',file],{timeout:3000});assert.equal(result.status,0);
   const probe=JSON.parse(result.stdout),v=probe.streams.find(s=>s.codec_type==='video'),a=probe.streams.find(s=>s.codec_type==='audio');
   const errors=[];
   if(!v||!a)errors.push('missing_track');
   if(v&&Number(v.nb_frames)>=10&&Number(v.duration)>0&&Number(v.nb_frames)/Number(v.duration)>30)errors.push('compressed_video_timeline');
   if(v&&a&&Math.abs(Number(v.duration)-Number(a.duration))>=1.5)errors.push('track_duration_mismatch');
   if(v&&a&&Math.abs(Number(v.start_time)-Number(a.start_time))>=1.5)errors.push('track_origin_mismatch');
   if(phase&&Number(probe.format.duration)>=10)errors.push('recovery_segment_duration');
   const decoded=spawnSync('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-map','0:a:0','-fps_mode:v','passthrough','-enc_time_base:v','1:90000','-f','null','-'],{timeout:3000});
   if(decoded.status!==0||decoded.stderr.toString().trim())errors.push('full_clip_decode');
   if(errors.length)boundaryErrors.push({name,phase,errors});
   console.log(JSON.stringify({syntheticSegment:name,phase,createdMs:start,completedMs:mtime,errors,decodeExit:decoded.status,decodeWarning:decoded.stderr.toString().slice(0,200),probe}));
   if(!phase)continue;
   if(!errors.length)verified.push(phase);
  }
  assert.ok(verified.includes('initial'),'initial A/V output recorded');
  assert.ok(verified.includes('video'),'video-stall recovery recorded');
  assert.ok(verified.includes('audio'),'audio-stall recovery recorded');
  assert.equal(/Non-monotonic DTS/.test(recorderWarnings),false,'no timestamp collision repair');
  assert.deepEqual(boundaryErrors,[],'all completed boundary clips preserve tracks and timeline');
  assert.equal(session.reconnects,0,'9-second media stalls recover without resetting the protocol session');
 }finally{stopped=true;clearInterval(tick);record?.kill('SIGKILL');go?.kill('SIGKILL');session?.stop();server?.closeAllConnections();server?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

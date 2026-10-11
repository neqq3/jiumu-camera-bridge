// SPDX-License-Identifier: Apache-2.0
'use strict';
// Synthetic recorders join an already running restream at different GOP phases.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {EventEmitter,once}=require('node:events'),{spawn,spawnSync}=require('node:child_process');
class Client extends EventEmitter{constructor(){super();this.stats={};}start(){}controlStatus(){return {};}close(){if(!this.closed){this.closed=true;this.emit('closed');}}frame(type,body){this.emit('data',1,{type,body});}}
require('../jiumu_bridge/lib/hlp-client.cjs').HlpClient=Client;
require('../jiumu_bridge/lib/media.cjs').MediaParser=class{constructor(fn){this.fn=fn;}accept(x){this.fn(x.type,x.body,{});}reset(){}};
const {CameraSession}=require('../jiumu_bridge/lib/session.cjs');
const {mediaSources,frigateInputArgs,frigateRecordArgs}=require('../jiumu_bridge/lib/transcode.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('new recording consumers have bounded initial audio/video track offset',{timeout:53000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-startup-')),children=[];
 let session,server,tick;const traces=[],files=[],errors=[];
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120','-frames:v','1','-threads','1','-f','image2pipe','-c:v','mjpeg','pipe:1'],{timeout:5000});assert.equal(generated.status,0);
 const started=Date.now(),elapsed=()=>Date.now()-started;
 try{
  session=new CameraSession({id:'synthetic',config:{}});
  server=http.createServer((req,res)=>session.serve(res,req.url.endsWith('/audio.wav')?'audio.wav':'stream.mjpeg'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  tick=setInterval(()=>{session.client.frame(3,generated.stdout);session.client.frame(7,Buffer.alloc(800,0xd5));},100);
  const sources=mediaSources(`http://127.0.0.1:${server.address().port}/cameras/synthetic`).map(s=>process.env.TEST_OLD_GOP==='1'?s.replace(' -g:v 10 ',' -g:v 20 '):s);
  const cfg=path.join(dir,'go.json');fs.writeFileSync(cfg,JSON.stringify({api:{listen:'127.0.0.1:18989'},rtsp:{listen:'127.0.0.1:18959'},webrtc:{listen:''},log:{level:'error'},streams:{source:sources,restream:'rtsp://127.0.0.1:18959/source'}}));
  children.push(spawn('/usr/local/bin/go2rtc',['-config',cfg],{stdio:'ignore'}));
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:18989/api',{signal:AbortSignal.timeout(200)})).ok)break;}catch{}await delay(100);}
  let warmed=false;
  const warm=spawn('ffmpeg',['-v','error',...frigateInputArgs,'-i','rtsp://127.0.0.1:18959/restream','-c','copy','-progress','pipe:1','-f','null','-'],{stdio:['ignore','pipe','ignore']});children.push(warm);warm.stdout.on('data',()=>{warmed=true;});
  for(let i=0;i<120&&!warmed;i++)await delay(100);assert.ok(warmed,'warm consumer got media');
  const launches=[];
  for(const offset of [100,1300]){
   await delay(offset===100?100:1200);
   for(const version of ['configured']){
    const label=`v${version}-offset${offset}`,binary=process.env.RECORDER_FFMPEG_BIN||'ffmpeg';
    const out=[...frigateRecordArgs];out[out.indexOf('-strftime')+1]='0';
    const input=[...frigateInputArgs];
    const p=spawn(binary,['-hide_banner','-loglevel','warning','-nostats','-threads','2',...input,'-i','rtsp://127.0.0.1:18959/restream','-t','23',...out,path.join(dir,label+'-%03d.mp4')],{stdio:['ignore','ignore','pipe']});
    children.push(p);let pending='',count=0;p.stderr.on('data',b=>{pending+=b;let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(count++<1500&&/demuxer|muxer|timestamp|DTS|Opening.*mp4/.test(line))traces.push({label,atMs:elapsed(),line:line.slice(0,700)});}});
    launches.push({label,process:p,done:once(p,'close'),started:elapsed()});
   }
  }
  const exits=await Promise.all(launches.map(async x=>({label:x.label,startedMs:x.started,exit:(await x.done)[0]})));
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.mp4')).sort()){
   const file=path.join(dir,name);const r=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,start_time,duration,nb_frames:format=duration','-of','json',file],{timeout:3000});assert.equal(r.status,0);
   const probe=JSON.parse(r.stdout),v=probe.streams.find(s=>s.codec_type==='video'),a=probe.streams.find(s=>s.codec_type==='audio'),bad=[];
   if(!v||!a)bad.push('missing_track');
   if(v&&a&&Math.abs(Number(v.start_time)-Number(a.start_time))>=1.5)bad.push('track_origin_mismatch');
   if(v&&a&&Math.abs(Number(v.duration)-Number(a.duration))>=1.5)bad.push('track_duration_mismatch');
   if(v&&Number(v.nb_frames)>=10&&Number(v.nb_frames)/Number(v.duration)>30)bad.push('compressed_video_timeline');
   const d=spawnSync(process.env.RECORDER_FFMPEG_BIN||'ffmpeg',['-v','error','-i',file,'-map','0:v:0','-map','0:a:0','-fps_mode:v','passthrough','-enc_time_base:v','1:90000','-f','null','-'],{timeout:3000});if(d.status!==0||d.stderr.toString().trim())bad.push('full_decode');
   files.push({name,probe,errors:bad,decodeExit:d.status,decodeWarning:d.stderr.toString().slice(0,300)});if(bad.length)errors.push({name,errors:bad});
  }
  console.log(JSON.stringify({exits,files,traces,oldGop:process.env.TEST_OLD_GOP==='1'}));
  assert.ok(files.length>=4,'completed clips from both joining phases');assert.ok(exits.every(x=>x.exit===0),'recorders exit normally');assert.deepEqual(errors,[],'all startup clips align');
 }finally{clearInterval(tick);for(const p of children)p.kill('SIGKILL');session?.stop();server?.closeAllConnections();server?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const mode of ['video-abort','audio-end','signal','unavailable','headers-timeout']){
 test(`encoder stops without delivering pipe EOF on ${mode}`,{timeout:12500},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'encoder-lifecycle-')),log=path.join(dir,'events');
  // Real process and OS pipes, but no codec/network dependency. This fake
  // encoder reports if an ordinary pipe EOF reaches it before it is killed.
  fs.writeFileSync(path.join(dir,'fake-codec.cjs'),`const fs=require('node:fs');const log=${JSON.stringify(log)};fs.appendFileSync(log,'start:'+process.pid+'\\n');for(const fd of [3,4]){const s=fs.createReadStream(null,{fd,autoClose:false});s.on('data',()=>{});s.on('end',()=>fs.appendFileSync(log,'EOF\\n'));}setTimeout(()=>process.exit(9),10000);\n`,{mode:0o755});
  const loader=path.join(dir,'load-codec.cjs');
  fs.writeFileSync(loader,`const cp=require('node:child_process'),real=cp.spawn;cp.spawn=(file,args,options)=>file==='ffmpeg'?real(process.execPath,[${JSON.stringify(path.join(dir,'fake-codec.cjs'))},...args],options):real(file,args,options);`);
  const responses=[],timers=[];let child,encoderPid;
  const server=http.createServer((req,res)=>{
   responses.push(res);
   if(mode==='unavailable'){res.writeHead(503);res.end();return;}
   if(mode==='headers-timeout')return;
   res.writeHead(200);res.write(Buffer.alloc(128));
   const timer=setInterval(()=>res.write(Buffer.alloc(128)),20);timers.push(timer);
   res.on('close',()=>clearInterval(timer));
  });
  try{
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const base=`http://127.0.0.1:${server.address().port}/cameras/synthetic`;
   child=spawn(process.execPath,['-r',loader,path.resolve(__dirname,'../jiumu_bridge/lib/media-encoder.cjs'),'-i',base+'/stream.mjpeg','-i',base+'/audio.wav','-f','rtsp','rtsp://127.0.0.1:18959/test'],{env:process.env,stdio:'ignore'});
   const start=Date.now(),closed=once(child,'close');
   if(!['unavailable','headers-timeout'].includes(mode)){
    for(let n=0;n<100&&!fs.existsSync(log);n++)await delay(20);
    assert.ok(fs.existsSync(log),'encoder starts with both inputs');
    encoderPid=Number(fs.readFileSync(log,'utf8').split(':')[1]);await delay(200);
    if(mode==='signal')child.kill('SIGTERM');
    else if(mode==='audio-end')responses[1].end();
    else responses[0].destroy();
   }
   const [code]=await closed;
   assert.equal(code,1,'go2rtc must retry this producer');
   assert.ok(Date.now()-start<(mode==='headers-timeout'?9500:3500),'bounded shutdown');
   if(encoderPid){
    assert.equal(fs.readFileSync(log,'utf8').includes('EOF'),false,'cached frames cannot flush on ordinary EOF');
    assert.throws(()=>process.kill(encoderPid,0),{code:'ESRCH'},'encoder was reaped');
   }else assert.equal(fs.existsSync(log),false,'unavailable input never starts encoder');
   for(let n=0;n<50&&responses.some(r=>!r.destroyed);n++)await delay(20);
   assert.ok(responses.every(r=>r.destroyed),'both HTTP peers were closed');
  }finally{
   child?.kill('SIGKILL');if(encoderPid)try{process.kill(encoderPid,'SIGKILL');}catch{}
   for(const timer of timers)clearInterval(timer);
   server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});
  }
 });
}

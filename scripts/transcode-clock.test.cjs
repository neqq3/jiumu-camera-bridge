// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {videoInput,videoFilter}=require('../jiumu_bridge/lib/transcode.cjs');

test('slow multipart JPEG delivery retains elapsed time in the encoded timeline',{timeout:15000},async()=>{
  // Only a synthetic blue image and loopback HTTP; no camera or credentials.
  const image=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120',
    '-frames:v','1','-threads','1','-f','image2pipe','-c:v','mjpeg','pipe:1'],{timeout:3000});
  assert.equal(image.status,0,'FFmpeg with lavfi/mjpeg is required for this integration test');
  const jpeg=image.stdout;assert.ok(jpeg.length>100);
  let emitted=0,firstAt,lastAt,child;
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'multipart/x-mixed-replace; boundary=frame'});
    const timer=setInterval(()=>{
      firstAt??=Date.now();lastAt=Date.now();emitted++;
      res.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),jpeg,Buffer.from('\r\n')]));
      if(emitted===20){clearInterval(timer);res.end('--frame--\r\n');}
    },333);
    res.once('close',()=>clearInterval(timer));
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const input=videoInput.replace('{input}',`http://127.0.0.1:${server.address().port}/stream`).split(' ');
    child=spawn('ffmpeg',['-v','error',...input,'-vf',videoFilter,'-threads','1','-progress','pipe:1','-f','null','-'],{timeout:11000,killSignal:'SIGKILL'});
    let progress='';child.stdout.on('data',b=>progress+=b);child.stderr.resume();
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0);assert.equal(emitted,20);
    const values={};for(const line of progress.trim().split('\n')){const i=line.indexOf('=');values[line.slice(0,i)]=line.slice(i+1);}
    const sourceSeconds=(lastAt-firstAt)/1000,outputSeconds=Number(values.out_time_us)/1e6;
    assert.ok(sourceSeconds>=6&&sourceSeconds<9,'Synthetic source timing was disrupted');
    assert.ok(Math.abs(outputSeconds-sourceSeconds)<0.8,`Timeline drift: source=${sourceSeconds}s output=${outputSeconds}s`);
    assert.ok(Number(values.frame)>=55,'Slow input must be resampled to a real-time 10 fps output');
  } finally {child?.kill('SIGKILL');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

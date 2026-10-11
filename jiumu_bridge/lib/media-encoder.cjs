// SPDX-License-Identifier: Apache-2.0
'use strict';
// Keep pipe writers open until child termination. Never let
// input loss become a normal FFmpeg EOF that flushes queued frames as live data.
const http=require('node:http');
const {spawn}=require('node:child_process');
const args=process.argv.slice(2),inputs=[],requests=[],responses=[];
let child,stopping=false;
for(let i=0;i<args.length;i++)if(args[i]==='-i'){
 const url=new URL(args[i+1]);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!/^\/cameras\/[a-z0-9_]+\/(stream\.mjpeg|audio\.wav)$/.test(url.pathname))throw Error('Local media input required');
 inputs.push({url,index:i+1});
}
if(inputs.length!==2)throw Error('Both media inputs required');
const output=new URL(args.at(-1));
if(output.protocol!=='rtsp:'||!['127.0.0.1','localhost'].includes(output.hostname)||output.username||output.password)throw Error('Local RTSP output required');
// rw_timeout is a protocol option for HTTP; remove it for pipe descriptors.
for(let i=args.length-2;i>=0;i--)if(args[i]==='-rw_timeout')args.splice(i,2);
let inputNumber=0;
for(let i=0;i<args.length;i++)if(args[i]==='-i')args[i+1]='pipe:'+(3+inputNumber++);
let preparationTimer;
function stop(){
 if(stopping)return;stopping=true;clearTimeout(preparationTimer);process.exitCode=1;
 // Kill before destroying HTTP responses or pipe writers.
 child?.kill('SIGKILL');
 for(const response of responses)response.destroy();
 for(const request of requests)request.destroy();

}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
preparationTimer=setTimeout(stop,8000);
Promise.all(inputs.map(input=>new Promise((resolve,reject)=>{
 const request=http.get(input.url,response=>{
  responses.push(response);
  if(response.statusCode!==200){response.resume();reject(Error('input unavailable'));return;}
  response.pause();response.setTimeout(8000,stop);
  response.on('end',stop);response.on('aborted',stop);response.on('error',stop);
  resolve(response);
 });
 requests.push(request);request.setTimeout(8000,()=>{request.destroy();reject(Error('input timeout'));});
 request.on('error',reject);
}))).then(streams=>{
 if(stopping)return;clearTimeout(preparationTimer);
 child=spawn('ffmpeg',args,{stdio:['ignore','inherit','inherit','pipe','pipe']});
 child.on('error',stop);child.on('exit',()=>{stop();process.exitCode=1;});
 for(let n=0;n<streams.length;n++){
  child.stdio[3+n].on('error',stop);
  streams[n].pipe(child.stdio[3+n],{end:false});
 }
}).catch(stop);

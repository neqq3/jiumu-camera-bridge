// SPDX-License-Identifier: Apache-2.0
'use strict';
const net=require('node:net');
function rtspPortAvailable(port) {
  return new Promise(resolve=>{
    // Probe IPv4 explicitly: HA Core already owns loopback port 18554. An
    // unrelated RTSP listener answering OPTIONS must not make us ready.
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen({host:'0.0.0.0',port,exclusive:true},()=>server.close(()=>resolve(true)));
  });
}
function probeRtsp(port) {
  return new Promise(resolve=>{
    let done=false,head='';
    const socket=net.connect({host:'127.0.0.1',port});
    const timer=setTimeout(()=>finish(false),700);
    function finish(value){if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value);}
    socket.on('connect',()=>socket.write('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
    socket.on('data',chunk=>{
      head+=chunk.toString('ascii');
      if(head.includes('\r\n'))finish(/^RTSP\/1\.0 (?:200|401) /.test(head));
      else if(head.length>4096)finish(false);
    });
    socket.on('error',()=>finish(false));socket.on('close',()=>finish(false));
  });
}
module.exports={probeRtsp,rtspPortAvailable};

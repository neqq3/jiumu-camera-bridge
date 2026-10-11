// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const https=require('node:https'),http=require('node:http'),{once}=require('node:events');
const {onboard}=require('../jiumu_bridge/lib/onboarding.cjs');

test('login deadline covers DNS lookup before a socket is connected',{timeout:19000},async t=>{
 const original=https.request;let request,lookups=0;
 t.after(()=>{https.request=original;request?.destroy();});
 // Native HTTPS client, but a deliberately unresolved resolver: no DNS query or vendor access.
 https.request=(options,listener)=>request=original({...options,agent:false,lookup:()=>{lookups++;}},listener);
 const started=Date.now();
 await assert.rejects(onboard('synthetic-account','synthetic-password'),e=>e.code==='cloud_unreachable');
 assert.equal(lookups,1);assert.ok(Date.now()-started<18000);assert.equal(request.destroyed,true);
});

test('login deadline also closes a response that never stops sending bytes',{timeout:19000},async t=>{
 const original=https.request;let request;
 const timers=new Set(),sockets=new Set();
 const server=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'application/json'});res.write('{');
  const timer=setInterval(()=>res.write(' '),50);timers.add(timer);
  res.on('close',()=>{clearInterval(timer);timers.delete(timer);});
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 t.after(async()=>{https.request=original;request?.destroy();for(const timer of timers)clearInterval(timer);for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 // Real streaming HTTP response over loopback; TLS/auth behavior is outside this timeout test.
 https.request=(options,listener)=>request=http.request({...options,hostname:'127.0.0.1',port:server.address().port,agent:false},listener);
 const started=Date.now();
 await assert.rejects(onboard('synthetic-account','synthetic-password'),e=>e.code==='cloud_unreachable');
 assert.ok(Date.now()-started<18000);assert.equal(request.destroyed,true);
});

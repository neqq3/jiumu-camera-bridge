// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
// Replace only the wire transport/parser, in this test process. No real network.
class Client extends EventEmitter {
 constructor(){super();this.stats={};this.closed=false;}
 start(){} controlStatus(){return {};}
 close(){if(!this.closed){this.closed=true;this.emit('closed');}}
 fail(reason){this.reason=reason;this.emit('failure',reason);this.close();}
 frame(type){this.emit('data',1,{type,body:type===3?Buffer.from([255,216,255,217]):Buffer.alloc(80)});}
}
require('../jiumu_bridge/lib/hlp-client.cjs').HlpClient=Client;
require('../jiumu_bridge/lib/media.cjs').MediaParser=class{constructor(fn){this.fn=fn;}accept(x){this.fn(x.type,x.body,{});}reset(){}};
const {CameraSession}=require('../jiumu_bridge/lib/session.cjs');
class Response extends EventEmitter {
 constructor(){super();this.writableLength=0;this.destroyed=false;}
 writeHead(code){this.code=code;}write(){}end(){this.ended=true;}
 destroy(){this.destroyed=true;this.emit('close');}
}
function setup(t){t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100000});const session=new CameraSession({id:'synthetic',config:{}});t.after(()=>session.stop());return session;}
test('video alone can supply a snapshot but cannot start the A/V encoder inputs',t=>{
 const s=setup(t);s.client.frame(3);
 const snap=new Response();s.serve(snap,'snapshot.jpg');assert.equal(snap.code,200);
 for(const kind of ['stream.mjpeg','audio.wav']){const res=new Response();s.serve(res,kind);assert.equal(res.code,503);}
 s.client.frame(7);
 for(const kind of ['stream.mjpeg','audio.wav']){const res=new Response();s.serve(res,kind);assert.equal(res.code,200);}
});
for(const stalled of ['video','audio'])test(`a stale ${stalled} track closes both HTTP inputs before the protocol timeout`,t=>{
 const s=setup(t);s.client.frame(3);s.client.frame(7);
 const v=new Response(),a=new Response();s.serve(v,'stream.mjpeg');s.serve(a,'audio.wav');
 for(let i=0;i<3;i++){t.mock.timers.tick(1000);s.client.frame(stalled==='video'?7:3);}
 assert.ok(v.destroyed&&a.destroyed);assert.equal(s.videoClients.size+s.audioClients.size,0);
 assert.equal(s.client.closed,false,'short outage should not reset the device session');
 s.client.frame(3);s.client.frame(7);
 const recovered=new Response();s.serve(recovered,'stream.mjpeg');assert.equal(recovered.code,200);
});
test('sustained audio loss retries the session even while video keeps arriving',t=>{
 const s=setup(t),client=s.client;client.frame(3);client.frame(7);
 for(let i=0;i<26;i++){client.frame(3);t.mock.timers.tick(1000);}
 assert.match(client.reason,/No fresh audio/);assert.equal(s.reconnects,1);
 t.mock.timers.tick(3000);assert.notEqual(s.client,client);
});
test('sub-threshold jitter leaves healthy A/V consumers attached',t=>{
 const s=setup(t);s.client.frame(3);s.client.frame(7);
 const v=new Response(),a=new Response();s.serve(v,'stream.mjpeg');s.serve(a,'audio.wav');
 for(let i=0;i<20;i++){t.mock.timers.tick(1000);s.client.frame(3);s.client.frame(7);}
 assert.equal(v.destroyed||a.destroyed,false);assert.equal(s.reconnects,0);
});

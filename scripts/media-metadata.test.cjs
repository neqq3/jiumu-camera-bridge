// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MediaParser}=require('../jiumu_bridge/lib/media.cjs');
function frame(index,time,body=Buffer.from([0xff,0xd8,0x00,0xff,0xd9])) {
  const h=Buffer.alloc(32);Buffer.from('55aa15a8','hex').copy(h);h[4]=3;
  h.writeUInt32LE(time,8);h.writeUInt32LE(index,12);h.writeUInt32LE(body.length,16);
  return Buffer.concat([h,body]);
}
test('fragmented and coalesced media retains unsigned camera header metadata with the correct frame',()=>{
  const received=[],p=new MediaParser((type,body,metadata)=>received.push({type,body:Buffer.from(body),metadata}));
  const a=frame(0xffffffff,1791732000),b=frame(0,1791732001);
  p.accept(a.subarray(0,11));assert.equal(received.length,0);
  p.accept(Buffer.concat([a.subarray(11),b]));
  assert.deepEqual(received.map(x=>x.metadata),[{time_seconds:1791732000,frame_index:0xffffffff},{time_seconds:1791732001,frame_index:0}]);
  assert.equal(received[0].type,3);assert.deepEqual(received[0].body,Buffer.from([0xff,0xd8,0x00,0xff,0xd9]));
});
test('reset during a partial frame does not assign stale metadata to the next complete frame',()=>{
  const received=[],p=new MediaParser((type,body,metadata)=>received.push(metadata));
  p.accept(frame(10,100).subarray(0,33));p.reset();
  p.accept(Buffer.concat([Buffer.from('noise'),frame(20,200)]));
  assert.deepEqual(received,[{time_seconds:200,frame_index:20}]);
});

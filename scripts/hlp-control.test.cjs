// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {HlpClient}=require('../jiumu_bridge/lib/hlp-client.cjs');
// Synthetic metadata creates a real client without any camera material or sockets.
const md5=b=>crypto.createHash('md5').update(b).digest('hex').toUpperCase();
const first=md5(Buffer.alloc(61)),second=md5([3,14,17,20,24].map(n=>first.slice(0,n)).join(''));
const body=Buffer.from(`${second.slice(24,32)},das,12345678,local,127.0.0.1,TEST\0`);
const padded=Buffer.alloc(Math.ceil(body.length/16)*16);body.copy(padded);
const cipher=crypto.createCipheriv('aes-128-cbc',Buffer.from(first.slice(0,16)),Buffer.from(second.slice(0,16)));cipher.setAutoPadding(false);
const server='DAS-'+Buffer.concat([cipher.update(padded),cipher.final()]).toString('hex');
function fixture(seq=0){
 const c=new HlpClient({did:'TEST12345678ABCDE',server,user:'admin',password:'synthetic-only'});
 c.connected=true;c.peer={address:'192.168.1.2',port:65530};c.seq=seq;c.sent=[];c.send=b=>c.sent.push(Buffer.from(b));
 return c;
}
function ack(channel,cursor,length=channel===11?14:5){
 const b=Buffer.alloc(length);b[0]=13;b[3]=channel;b.writeUInt16BE(cursor,1);return b;
}
test('cumulative ACK retires lost individual confirmations without skipping an unreceived control packet',()=>{
 const c=fixture();for(let i=0;i<3;i++)c.write(0,Buffer.from('test'));
 c.receive(ack(11,2),c.peer);
 assert.deepEqual([...c.outgoing.keys()],[2]);assert.equal(c.stats.acks,2);
 c.receive(ack(11,2),c.peer);assert.equal(c.stats.acks,2);
 c.receive(ack(10,3),c.peer);assert.equal(c.outgoing.size,0);assert.equal(c.stats.acks,3);
});
test('cumulative ACK handles sequence wrap and rejects future cursors and wrong peers',()=>{
 const c=fixture(65534);for(let i=0;i<3;i++)c.write(0,Buffer.from('test'));
 c.receive(ack(11,3),c.peer);assert.equal(c.outgoing.size,3);
 c.receive(ack(11,1),{...c.peer,address:'192.168.1.3'});assert.equal(c.outgoing.size,3);
 c.receive(ack(11,1),c.peer);assert.deepEqual([...c.outgoing.keys()],[1]);
 c.receive(ack(11,0),c.peer);assert.deepEqual([...c.outgoing.keys()],[1]);
 c.receive(ack(11,2),c.peer);assert.equal(c.outgoing.size,0);
});
test('malformed cumulative confirmations cannot discard pending control data',()=>{
 const c=fixture();c.write(0,Buffer.from('test'));
 for(const b of [ack(11,1,5),ack(10,1,14),ack(11,65535)])c.receive(b,c.peer);
 assert.equal(c.outgoing.size,1);
});
test('individual ACK also advances the cumulative cursor without double counting',()=>{
 const c=fixture();for(let i=0;i<3;i++)c.write(0,Buffer.from('test'));
 const unmatched=ack(8,2,11);unmatched.writeUInt16BE(999,5);unmatched.writeUInt16BE(999,7);
 c.receive(unmatched,c.peer);assert.deepEqual([...c.outgoing.keys()],[2]);assert.equal(c.stats.acks,2);
 const b=ack(8,3,11);b.writeUInt16BE(2,5);b.writeUInt16BE(2,7);
 c.receive(b,c.peer);assert.equal(c.outgoing.size,0);assert.equal(c.stats.acks,3);
 c.receive(b,c.peer);assert.equal(c.stats.acks,3);
});
test('a live camera can recover a delayed control acknowledgement without an early retry-count disconnect',()=>{
 const c=fixture();c.autoStream=false;const now=Date.now();c.lastReceive=now;c.pingAt=now;
 c.fail=reason=>{c.failure=reason;};c.write(0,Buffer.from('test'));
 const p=c.outgoing.get(0);p.createdAt=now-12000;p.at=now-2000;p.retries=11;
 c.tick();assert.equal(c.failure,undefined);assert.equal(p.retries,12);
 c.receive(ack(11,1),c.peer);assert.equal(c.outgoing.size,0);
});
test('control retries retain an absolute deadline and peer inactivity still fails promptly',()=>{
 const c=fixture();c.autoStream=false;const now=Date.now();c.lastReceive=now;c.pingAt=now;
 c.fail=reason=>{c.failure=reason;};c.write(0,Buffer.from('test'));
 c.outgoing.get(0).createdAt=now-30001;c.tick();assert.equal(c.failure,'Camera did not acknowledge control command');
 c.failure=undefined;c.outgoing.get(0).createdAt=now;c.lastReceive=now-15001;c.tick();
 assert.equal(c.failure,'Camera connection timed out');
});
test('a pending command prevents redundant keepalives from accumulating',()=>{
 const c=fixture();const now=Date.now();c.lastReceive=now;c.pingAt=now;c.keepAliveAt=now-6000;
 c.write(0,Buffer.from('test'));c.tick();assert.equal(c.outgoing.size,1);
 c.receive(ack(11,1),c.peer);c.tick();assert.equal(c.outgoing.size,2);
});

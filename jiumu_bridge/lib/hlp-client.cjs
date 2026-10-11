'use strict';
const dgram=require('node:dgram');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const os=require('node:os');
const {aes,network,identity,sessionKey}=require('./hlp-crypto.cjs');
const VERSION=0x1352835,MAX_MESSAGE=2*1024*1024;
const next=n=>(n+1)%65535;
function isLan(ip) {
  const a=ip.split('.').map(Number);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && a.every(n=>n>=0&&n<=255) && (a[0]===10 || a[0]===192&&a[1]===168 || a[0]===172&&a[1]>=16&&a[1]<=31);
}
function broadcastAddresses() {
  const addresses=new Set(['255.255.255.255']);
  for(const list of Object.values(os.networkInterfaces()))for(const n of list||[]) {
    if(n.family!=='IPv4' || n.internal || !isLan(n.address))continue;
    const ip=n.address.split('.').map(Number),mask=n.netmask.split('.').map(Number);
    addresses.add(ip.map((v,i)=>v | (~mask[i]&255)).join('.'));
  }
  return [...addresses];
}
class HlpClient extends EventEmitter {
  constructor(config,{ipHint,timeout=20000,autoStream=true}={}) {
    super();this.config=config;this.net=network(config.server);this.id=identity(config.did);
    if(ipHint && !isLan(ipHint))throw new Error('Only private IPv4 camera addresses are allowed');
    this.ipHint=ipHint;this.timeout=timeout;this.autoStream=autoStream;this.aid=crypto.randomInt(100000000,900000000);
    this.nonce=crypto.randomInt(10000000,90000000);this.uid=crypto.randomInt(100000000,900000000);
    this.key=sessionKey(this.net.key,this.nonce);this.seq=0;this.recvSeq=0;this.received=new Set();
    this.messageIds=Array(8).fill(0);this.expected=Array(8).fill(0);this.groups=new Map();this.complete=new Map();this.outgoing=new Map();
    this.stats={packets:0,acks:0,retries:0,invalid:0,messages:0,dropped:0};this.closed=false;this.ackTrace=[];
  }
  start() {
    this.socket=dgram.createSocket('udp4');
    this.socket.on('error',()=>this.fail('Camera UDP socket failed'));
    this.socket.on('message',(b,peer)=>{try{this.receive(b,peer);}catch(_){this.stats.invalid++;}});
    this.socket.bind(0,'0.0.0.0',()=>{
      this.socket.setBroadcast(true);this.started=Date.now();this.discover();
      this.timer=setInterval(()=>this.tick(),200);
    });return this;
  }
  fail(message) {if(this.closed)return;this.emit('failure',message);this.close();}
  send(buffer,peer=this.peer) {
    if(this.closed || !peer)return;
    this.socket.send(buffer,peer.port,peer.address,()=>{});
  }
  discover() {
    const plain=Buffer.alloc(16);plain.writeUInt32LE(this.net.group,0);plain.writeUInt32LE(this.aid,4);
    this.id.prefix.copy(plain,8);plain.writeUInt32LE(this.id.serial,12);
    const b=Buffer.alloc(25);b[0]=2;aes(plain,this.net.key).copy(b,1);b.writeUInt32LE(this.nonce,17);b.writeUInt32LE(VERSION,21);
    const addresses=this.ipHint?[this.ipHint]:broadcastAddresses();
    for(const address of addresses)for(const port of [65530,65531])this.send(b,{address,port});
    this.discoveryAt=Date.now();
  }
  tick() {
    const now=Date.now();
    if(!this.connected) {
      if(now-this.started>this.timeout)return this.fail('Camera not found on the local network');
      if(now-this.discoveryAt>1000)this.discover();
      return;
    }
    if(now-this.lastReceive>15000)return this.fail('Camera connection timed out');
    if(now-this.pingAt>3000) {this.send(Buffer.from([0x0b,0,0]));this.pingAt=now;}
    // Do not queue more keepalive commands behind an unacknowledged command.
    if(this.autoStream&&!this.outgoing.size&&now-this.keepAliveAt>5000) {this.cgi('trans_cmd_string.cgi?cmd=2131&command=1&DevActiveTime=10&');this.keepAliveAt=now;}
    for(const [seq,p] of this.outgoing) {
      // A live camera may acknowledge control after several seconds. Keep a
      // fixed deadline rather than treating ten short retries as a dead peer.
      if(now-p.createdAt>=30000)return this.fail('Camera did not acknowledge control command');
      if(now-p.at<Math.min(600*2**Math.min(p.retries,2),1500))continue;
      p.retries++;
      p.at=now;this.stats.retries++;this.send(p.buffer);
    }
    for(const [id,g] of this.groups)if(now-g.at>2500){this.groups.delete(id);this.stats.dropped++;}
    for(let channel=0;channel<8;channel++)this.drain(channel,now);
  }
  receive(b,peer) {
    if(this.closed || b.length<1 || b.length>1500 || !isLan(peer.address))return;
    if(!this.connected && b[0]===0x11 && b.length===15 && b.readUInt32LE(1)===this.aid && b.readUInt32LE(5)===this.nonce) {
      if(this.ipHint && peer.address!==this.ipHint)return;
      this.peer={address:peer.address,port:peer.port};this.deviceVersion=b.readUInt32LE(11);
      const reply=Buffer.alloc(18);reply[0]=0x11;reply[1]=b[9];reply.writeUInt32LE(this.aid,2);
      reply.writeUInt32LE(this.nonce,6);reply.writeUInt32LE(VERSION,10);reply.writeUInt32LE(this.uid,14);
      this.send(reply);this.send(reply);return;
    }
    if(!this.peer || peer.address!==this.peer.address || peer.port!==this.peer.port)return;
    this.stats.packets++;this.lastReceive=Date.now();
    if(!this.connected && b[0]===0x15 && b.length===9 && b.readUInt32LE(1)===this.aid) {
      this.connected=true;this.pingAt=this.lastReceive;this.keepAliveAt=this.lastReceive;
      this.send(Buffer.from([0x0b,0,0]));this.emit('connected',{address:peer.address,port:peer.port});
      if(!this.autoStream)return;
      this.loginTimer=setTimeout(()=>{if(!this.closed)this.cgi('get_status.cgi?name=admin&');},200);
      this.startTimer=setTimeout(()=>{
        if(this.closed)return;
        this.cgi('livestream.cgi?streamid=10&substream=1&');
        this.cgi('audiostream.cgi?streamid=1&adpcm_ver=1&');
      },1700);return;
    }
    if(!this.connected)return;
    if(b[0]===0x0b) {this.send(Buffer.from([0x0c]));return;}
    if(b[0]!==0x0d || b.length<5)return;
    const channel=b[3],seq=b.readUInt16BE(1);
    if([8,10,11].includes(channel)&&b.length===(channel===8?11:channel===10?5:14)) {
      this.ackTrace.push({at:Date.now(),channel,cursor:seq,paused_channels:b[4],...(channel===8?{id:b.readUInt16BE(5),seq:b.readUInt16BE(7)}:{})});
      if(this.ackTrace.length>24)this.ackTrace.shift();
    }
    if(channel===8) {
      if(b.length!==11)return;
      const ackSeq=b.readUInt16BE(7),id=b.readUInt16BE(5),pending=this.outgoing.get(ackSeq);
      if(pending && pending.id===id){this.outgoing.delete(ackSeq);this.stats.acks++;}
      this.ackThrough(seq);
      return;
    }
    // SDK channels 10 and 11 carry the first sequence not yet received.
    // Channel 11 adds nine bytes of flow statistics and needs no reply.
    if(channel===10 || channel===11) {
      if(b.length===(channel===10?5:14))this.ackThrough(seq);
      return;
    }
    if(channel===9) {const answer=Buffer.from([13,0,0,10,0]);answer.writeUInt16BE(this.recvSeq,1);this.send(answer);return;}
    if(channel>=8)return;
    if(b.length<14 || seq===65535)return;
    const id=b.readUInt16BE(5),length=b.readUInt16BE(7),index=b.readUInt16BE(9),count=b.readUInt16BE(11);
    if(length!==b.length-5 || count===0 || count>2048 || index>=count || id===65535){this.stats.invalid++;return;}
    if((seq-this.recvSeq+65535)%65535<32768)this.received.add(seq);
    while(this.received.has(this.recvSeq)){this.received.delete(this.recvSeq);this.recvSeq=next(this.recvSeq);}
    if(this.received.size>4096)return this.fail('Receive sequence window exceeded');
    const ack=Buffer.alloc(11);ack[0]=13;ack.writeUInt16BE(this.recvSeq,1);ack[3]=8;
    ack.writeUInt16BE(id,5);ack.writeUInt16BE(seq,7);ack.writeUInt16BE(b.length-13,9);this.send(ack);
    // Reject IDs behind the delivery point, including completed retransmissions.
    const distance=(id-this.expected[channel]+65535)%65535;if(distance>32767)return;
    const key=channel+':'+id;if(this.complete.has(key))return;
    let group=this.groups.get(key);
    if(!group) {
      if(this.groups.size>=64){this.stats.dropped++;return;}
      group={channel,id,count,at:Date.now(),parts:new Map(),bytes:0};this.groups.set(key,group);
    }
    if(group.count!==count){this.groups.delete(key);this.stats.invalid++;return;}
    const part=b.subarray(13),previous=group.parts.get(index);
    if(previous) {if(!previous.equals(part)){this.groups.delete(key);this.stats.invalid++;}return;}
    group.parts.set(index,Buffer.from(part));group.bytes+=part.length;
    if(group.bytes>MAX_MESSAGE){this.groups.delete(key);this.stats.invalid++;return;}
    if(group.parts.size!==count)return;
    const fragments=[];for(let i=0;i<count;i++)fragments.push(group.parts.get(i));
    const body=Buffer.concat(fragments);this.groups.delete(key);
    let payload=body.subarray(1);
    if(body[0]===1) {
      payload=aes(payload,this.key,true);
      if(payload.length<5 || payload[0]!==0xfa || payload.readUInt32BE(1)>payload.length-5){this.stats.invalid++;return;}
      payload=payload.subarray(5,5+payload.readUInt32BE(1));
    } else if(body[0]!==0){this.stats.invalid++;return;}
    if(this.complete.size>=128)return this.fail('Message ordering buffer exceeded');
    this.complete.set(key,{payload,at:Date.now(),id});this.drain(channel,Date.now());
  }
  ackThrough(cursor) {
    // Never accept a cursor beyond what we sent. Current control traffic and
    // the retry deadline keep pending sequence spans below the modulo half-range.
    if(cursor===65535 || (this.seq-cursor+65535)%65535>32767)return;
    for(const seq of this.outgoing.keys()) {
      const distance=(cursor-seq+65535)%65535;
      if(distance>0 && distance<32768){this.outgoing.delete(seq);this.stats.acks++;}
    }
  }
  controlStatus() {
    return {next_seq:this.seq,received_seq:this.recvSeq,
      pending:[...this.outgoing].map(([seq,p])=>({seq,id:p.id,retries:p.retries,bytes:p.buffer.length})),
      acknowledgements:this.ackTrace.slice()};
  }
  drain(channel,now) {
    let key=channel+':'+this.expected[channel];
    // A missing whole message must not block the stream forever. Reset media
    // framing before skipping a gap so a partial JPEG cannot become a new frame.
    if(!this.complete.has(key)) {
      const waiting=[...this.complete.entries()].filter(([k])=>k.startsWith(channel+':'));
      if(waiting.length && waiting.some(([,v])=>now-v.at>2000)) {
        waiting.sort((a,b)=>(a[1].id-this.expected[channel]+65535)%65535-(b[1].id-this.expected[channel]+65535)%65535);
        this.expected[channel]=waiting[0][1].id;key=channel+':'+this.expected[channel];this.emit('gap',channel);this.stats.dropped++;
      }
    }
    while(this.complete.has(key)) {
      const value=this.complete.get(key);this.complete.delete(key);this.stats.messages++;
      this.emit('data',channel,value.payload);this.expected[channel]=next(this.expected[channel]);key=channel+':'+this.expected[channel];
    }
  }
  write(channel,data) {
    if(this.closed || !this.connected)return;
    const plain=Buffer.alloc(Math.floor((data.length+5)/16)*16+16);plain[0]=0xfa;plain.writeUInt32BE(data.length,1);data.copy(plain,5);
    const payload=Buffer.concat([Buffer.from([1]),aes(plain,this.key)]);
    const count=Math.ceil(payload.length/1100),id=this.messageIds[channel];this.messageIds[channel]=next(id);
    if(this.outgoing.size+count>64)return this.fail('Control send queue exceeded');
    for(let index=0;index<count;index++) {
      const fragment=payload.subarray(index*1100,(index+1)*1100),b=Buffer.alloc(13+fragment.length),seq=this.seq;
      this.seq=next(seq);b[0]=13;b.writeUInt16BE(seq,1);b[3]=channel;b.writeUInt16BE(id,5);
      b.writeUInt16BE(fragment.length+8,7);b.writeUInt16BE(index,9);b.writeUInt16BE(count,11);fragment.copy(b,13);
      const now=Date.now();this.outgoing.set(seq,{buffer:b,id,at:now,createdAt:now,retries:0});this.send(b);
    }
  }
  cgi(command) {
    const text=Buffer.from(`GET /${command}loginuse=${this.config.user}&loginpas=${this.config.password}&user=admin&pwd=888888&`);
    const header=Buffer.alloc(8);header.writeUInt16LE(0x0a01,0);header.writeUInt16LE(text.length,4);
    this.write(0,header);this.write(0,text);
  }
  close() {
    if(this.closed)return;
    this.closed=true;clearInterval(this.timer);clearTimeout(this.startTimer);clearTimeout(this.loginTimer);
    const shutdown=()=>{if(this.socket)try{this.socket.close();}catch(_){}};
    // hl_p2p_close uses _se_sndto(cmd=10, dataLength=0): one byte 0x0a.
    if(this.connected)this.socket.send(Buffer.from([10]),this.peer.port,this.peer.address,shutdown);else shutdown();
    this.groups.clear();this.complete.clear();this.outgoing.clear();this.received.clear();this.emit('closed');
  }
}
module.exports={HlpClient,isLan,broadcastAddresses};

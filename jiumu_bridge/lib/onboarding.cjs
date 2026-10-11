'use strict';
// Independent onboarding for Jiumu 1.0.12 / LANGXING, derived from libapp.so
// AppWebClient::_requestOptions and MQTTManagerThree, then verified on the wire.
const crypto = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const {deviceConfig, properties} = require('./onboarding_crypto.cjs');
const {network,identity}=require('./hlp-crypto.cjs');
const {SetupError}=require('./setup-errors.cjs');

// Shared application identifiers, not a user's account or camera credentials.
const APP_SECRET = 'c0d1e2f3g4h5i6j7k8l9m0n1o2p3q4r5s6t7u8v9w0x1y2z';
const ACCESS_KEY = '5a6b7c8d9e0f1a2b';
const MAX_PACKET = 4 * 1024 * 1024;
function signedHeaders(timestamp = Math.floor(Date.now()/1000), ran = crypto.randomInt(500000)) {
  return {accesskey: ACCESS_KEY, timestamp: String(timestamp), ran: String(ran),
    encryp: crypto.createHash('md5').update(APP_SECRET + timestamp + ran).digest('hex')};
}
function request(path, body) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject) => {
    const req = https.request({hostname:'api-gateway-1.eye4cloud.com',path,method:'POST',
      headers:{...signedHeaders(),client_mark:'LANGXING',client_type:'1',client_number:'119',
        client_version:'1.0.12',oemid:'VSTC',country_code:'156',language:'zh',
        'content-type':'application/json','content-length':data.length}, timeout:15000}, res => {
      let length=0;const chunks=[];
      res.on('data',b=>{length+=b.length;if(length>MAX_PACKET)res.destroy(new Error('Response too large'));else chunks.push(b);});
      res.on('error',reject);
      res.on('end',()=>{
        try {
          const obj=JSON.parse(Buffer.concat(chunks).toString());
          if(res.statusCode!==200 || obj.code!==200) throw new SetupError('login_rejected');
          resolve(obj.data);
        } catch(e) {reject(e instanceof SetupError ? e : new SetupError('cloud_response'));}
      });
    });
    req.on('timeout',()=>req.destroy(new SetupError('cloud_unreachable')));
    req.on('error',()=>reject(new SetupError('cloud_unreachable')));req.end(data);
  });
}
function varint(number) {
  let n=BigInt(number);const bytes=[];
  if(n<0n)n=BigInt.asUintN(64,n);
  do {let b=Number(n&127n);n>>=7n;if(n)b|=128;bytes.push(b);} while(n);
  return Buffer.from(bytes);
}
function readVarint(buffer,offset,maxBytes=10) {
  let n=0n;
  for(let i=0;i<maxBytes;i++) {
    if(offset+i>=buffer.length)return null;
    const b=buffer[offset+i];n|=BigInt(b&127)<<BigInt(i*7);
    if(!(b&128))return {value:n,next:offset+i+1};
  }
  throw new Error('Invalid variable-length integer');
}
function protobuf(buffer) {
  const fields=new Map();let offset=0;
  while(offset<buffer.length) {
    const tag=readVarint(buffer,offset);if(!tag)throw new Error('Truncated protobuf tag');offset=tag.next;
    const wire=Number(tag.value&7n),field=Number(tag.value>>3n);
    if(wire===0) {
      const v=readVarint(buffer,offset);if(!v)throw new Error('Truncated protobuf integer');fields.set(field,v.value);offset=v.next;
    } else if(wire===2) {
      const v=readVarint(buffer,offset);if(!v || v.value>BigInt(MAX_PACKET))throw new Error('Invalid protobuf length');
      const end=v.next+Number(v.value);if(end>buffer.length)throw new Error('Truncated protobuf data');
      fields.set(field,buffer.subarray(v.next,end));offset=end;
    } else if(wire===1 || wire===5) {
      offset+=wire===1?8:4;if(offset>buffer.length)throw new Error('Truncated protobuf fixed value');
    } else throw new Error('Unsupported protobuf wire type');
  }
  return fields;
}
function mqttString(value) {
  const b=Buffer.from(value);if(b.length>65535)throw new Error('MQTT string too long');
  const n=Buffer.alloc(2);n.writeUInt16BE(b.length);return Buffer.concat([n,b]);
}
function packet(header,body) {return Buffer.concat([Buffer.from([header]),varint(body.length),body]);}

function getDevices(uid,token,{timeout=25000,onProgress=()=>{}}={}) {
  return new Promise((resolve,reject)=>{
    const host='app-mqtt-gateway-1.eye4cloud.com';
    const socket=tls.connect({host,port:8883,servername:host,rejectUnauthorized:true});
    let pending=Buffer.alloc(0),done=false;
    const timer=setTimeout(()=>finish(new Error('Device-list request timed out')),timeout);
    function finish(error,value) {
      if(done)return;done=true;clearTimeout(timer);
      if(!error)socket.end(Buffer.from([0xe0,0]));else socket.destroy();
      if(error)reject(error);else resolve(value);
    }
    socket.on('error',()=>finish(new Error('Vendor MQTT TLS connection failed')));
    socket.on('close',()=>{if(!done)finish(new Error('Vendor closed the device-list connection'));});
    socket.on('secureConnect',()=>{
      onProgress('MQTT TLS verified');
      const body=Buffer.concat([mqttString('MQTT'),Buffer.from([4,0xc2,0,30]),
        mqttString(`${uid}_${Math.floor(Date.now()/1000)}`),mqttString(String(uid)),mqttString(token)]);
      socket.write(packet(0x10,body));
    });
    socket.on('data',chunk=>{
      try {
        if(done)return;
        if(pending.length+chunk.length>MAX_PACKET)throw new Error('MQTT buffer limit exceeded');
        pending=Buffer.concat([pending,chunk]);
        while(pending.length>=2) {
          const size=readVarint(pending,1,4);if(!size)return;
          const length=Number(size.value);if(length>MAX_PACKET)throw new Error('MQTT packet too large');
          const end=size.next+length;if(end>pending.length)return;
          const flags=pending[0],kind=flags>>4,body=pending.subarray(size.next,end);pending=pending.subarray(end);
          if(kind===2) {
            if(body.length!==2 || body[1]!==0)throw new Error('MQTT account authentication rejected');
            onProgress('MQTT account accepted');
            socket.write(packet(0x82,Buffer.concat([Buffer.from([0,1]),mqttString(`app/${uid}/#`),Buffer.from([1])])));
          } else if(kind===9) {
            if(body.length<3 || body[2]===0x80)throw new Error('Device-list subscription rejected');
            // Field 1 = deviceList revision; 0 requests a complete initial list.
            const payload=Buffer.concat([varint(8),varint(0),varint(16*8),varint(15)]);
            socket.write(packet(0x30,Buffer.concat([mqttString(`app/${uid}/refresh_data`),payload])));
          } else if(kind===3) {
            if(body.length<2)throw new Error('Invalid MQTT publish');
            const topicLength=body.readUInt16BE(0);let pos=2+topicLength;
            if(pos>body.length)throw new Error('Invalid MQTT topic');
            const topic=body.subarray(2,pos).toString();const qos=(flags>>1)&3;
            if(qos>1)throw new Error('Unsupported MQTT QoS');
            if(qos) {
              if(pos+2>body.length)throw new Error('Invalid MQTT packet identifier');
              socket.write(packet(0x40,body.subarray(pos,pos+2)));pos+=2;
            }
            if(topic!==`app/${uid}/refresh_data/resp`)continue;
            const fields=protobuf(body.subarray(pos));const name=fields.get(1);
            if(!Buffer.isBuffer(name) || name.toString()!=='deviceList')continue;
            const data=fields.get(3);if(!Buffer.isBuffer(data))throw new Error('Device list missing');
            const devices=JSON.parse(data.toString());if(!Array.isArray(devices))throw new Error('Unexpected device list');
            finish(null,devices);return;
          }
        }
      } catch(_) {finish(new Error('Invalid device-list response'));}
    });
  });
}
function prepareDevices(userId,devices){
  if(!Array.isArray(devices))throw new SetupError('device_list');
  return devices.map(device=>{
    const name=String(device?.info?.nickname||'Camera').slice(0,100);
    if(Number(device?.p2p?.type)!==26)return {name,supported:false,reason:'此设备协议暂未支持',config:null};
    try {
      const config=deviceConfig(userId,device);network(config.server);identity(config.did);
      return {name,supported:true,config};
    }catch(_){return {name,supported:false,reason:'设备连接信息不可用，请在官方 APP 确认绑定后重新获取',config:null};}
  });
}
async function onboard(account,password,{onProgress=()=>{}}={}) {
  if(!account || !password)throw new SetupError('account_input');
  const lookup=await request('/user/login/textOfId',{text:account,oemid:'VSTC',skipName:false});
  if(!lookup?.uid)throw new SetupError('cloud_response');
  onProgress('Account found');
  const login=await request('/user/login/common',{uid:String(lookup.uid),password});
  if(!login?.token || !login.uid)throw new SetupError('cloud_response');
  onProgress('Independent account login succeeded');
  let devices;
  try{devices=await getDevices(String(login.uid),login.token,{onProgress});}
  catch(_){throw new SetupError('device_list');}
  // Deliberately return camera data only; never persist the cloud session/password.
  return prepareDevices(login.uid,devices);
}
module.exports={signedHeaders,onboard,getDevices,protobuf,varint,readVarint,properties,prepareDevices};

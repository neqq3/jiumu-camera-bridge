// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {once}=require('node:events'),{spawn}=require('node:child_process');
const {prepareDevices}=require('../jiumu_bridge/lib/onboarding.cjs');
// Synthetic fixtures only. No vendor account, real camera or network credentials.
const userId='123456',devicePassword='synthetic-device-password',accountPassword='synthetic-account-password';
const md5=v=>crypto.createHash('md5').update(v).digest('hex').toUpperCase();
const first=md5(Buffer.alloc(61)),second=md5([3,14,17,20,24].map(n=>first.slice(0,n)).join(''));
const body=Buffer.from(`${second.slice(24,32)},das,12345678,local,127.0.0.1,TEST\0`),padded=Buffer.alloc(Math.ceil(body.length/16)*16);body.copy(padded);
const cipher=crypto.createCipheriv('aes-128-cbc',Buffer.from(first.slice(0,16)),Buffer.from(second.slice(0,16)));cipher.setAutoPadding(false);
const server='DAS-'+Buffer.concat([cipher.update(padded),cipher.final()]).toString('hex');
const enc=crypto.createCipheriv('aes-128-cbc',crypto.createHash('md5').update(userId+'_+Vstarcam++20200715').digest(),Buffer.alloc(16));
const security=Buffer.concat([enc.update(devicePassword),enc.final()]).toString('hex');
const vendor={info:{nickname:'New camera'},p2p:{type:26,did:'TEST12345678ABCDE',address:server},security};
const valid=prepareDevices(userId,[vendor])[0];

test('one unusable device does not hide other usable cameras',()=>{
  const list=prepareDevices(userId,[vendor,{p2p:{type:1}},{...vendor,security:'invalid'}, {...vendor,p2p:{...vendor.p2p,did:'invalid'}},null]);
  assert.deepEqual(list.map(d=>d.supported),[true,false,false,false,false]);
  assert.equal(list[0].config.password,devicePassword);
  for(const item of list.slice(1)){assert.equal(item.config,null);assert.equal(typeof item.reason,'string');assert.ok(!item.reason.includes('invalid'));}
  assert.deepEqual(prepareDevices(userId,[]),[]);
});

async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function setup(t,scenario={devices:[valid]},existing=false){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-onboarding-'));
  const original={version:1,cameras:existing?[{id:'camera_existing',name:'Original camera',config:valid.config,ipHint:''}]:[],rtsp:{username:'viewer',password:'synthetic-rtsp-password'}};
  fs.writeFileSync(path.join(dir,'bridge.json'),JSON.stringify(original));
  const scenarioFile=path.join(dir,'scenario.json');fs.writeFileSync(scenarioFile,JSON.stringify(scenario));
  const preload=path.join(dir,'preload.cjs'),lib=path.resolve(__dirname,'../jiumu_bridge/lib');
  fs.writeFileSync(preload,`const fs=require('node:fs');const {SetupError}=require(${JSON.stringify(path.join(lib,'setup-errors.cjs'))});
require(${JSON.stringify(path.join(lib,'onboarding.cjs'))}).onboard=async()=>{const x=JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}));if(x.code)throw new SetupError(x.code);if(x.rawError)throw new Error(x.rawError);return x.devices;};
require(${JSON.stringify(path.join(lib,'session.cjs'))}).CameraSession=class{constructor(c){this.c=c;}status(){const x=JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}));return {id:this.c.id,name:this.c.name,fresh:!!x.videoFresh,audio_fresh:!!x.audioFresh,reconnects:0};}stop(){}};`);
  const apiPort=await port(),mediaPort=await port();
  const child=spawn(process.execPath,['--require',preload,path.resolve(__dirname,'../jiumu_bridge/server.cjs')],{env:{...process.env,DATA_DIR:dir,PORT:String(apiPort),MEDIA_PORT:String(mediaPort),LOCAL_ONLY:'0',HA_INGRESS:'0',DISABLE_GO2RTC:'1'},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);const ended=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await ended;}fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${apiPort}/api/`;
  let ready=false;for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error('server_exited');try{ready=(await fetch(base+'mode',{signal:AbortSignal.timeout(300)})).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  const token=fs.readFileSync(path.join(dir,'admin-token'),'utf8').trim();
  async function request(route,value){const r=await fetch(base+route,{method:value?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Jiumu-Request':'1'},body:value?JSON.stringify(value):undefined,signal:AbortSignal.timeout(1000)});return {status:r.status,body:await r.json()};}
  return {dir,request,original,stderr:()=>stderr,login:()=>request('login',{account:'synthetic-account',password:accountPassword}),health:()=>fetch(`http://127.0.0.1:${mediaPort}/health`,{signal:AbortSignal.timeout(1000)}),setHealth:(v,a)=>fs.writeFileSync(scenarioFile,JSON.stringify({...scenario,videoFresh:v,audioFresh:a}))};
}

test('media health requires fresh audio as well as video',{timeout:12000},async t=>{
  const s=await setup(t,{devices:[valid]},true);
  for(const [video,audio,status] of [[true,false,503],[false,true,503],[true,true,200]]){s.setHealth(video,audio);assert.equal((await s.health()).status,status);}
});

test('empty login is rejected before invoking cloud onboarding',{timeout:12000},async t=>{
  const s=await setup(t,{rawError:'must not be called'});const r=await s.request('login',{account:' ',password:''});
  assert.equal(r.status,400);assert.equal(r.body.code,'account_input');
});
for(const code of ['cloud_unreachable','login_rejected','device_list'])test(`onboarding explains ${code} without exposing raw details`,{timeout:12000},async t=>{
  const s=await setup(t,{code});const r=await s.login();assert.equal(r.status,502);assert.equal(r.body.code,code);
  assert.ok(!fs.readFileSync(path.join(s.dir,'bridge.json'),'utf8').includes(accountPassword));assert.equal(s.stderr(),'');
});
test('unexpected vendor errors never appear verbatim in API responses',{timeout:12000},async t=>{
  const secret='synthetic-opaque-secret';const s=await setup(t,{rawError:secret});const r=await s.login();
  assert.equal(r.body.code,'cloud_response');assert.ok(!JSON.stringify(r).includes(secret));assert.equal(s.stderr(),'');
});
test('selection reports expired login and invalid IP without clearing usable credentials',{timeout:12000},async t=>{
  const s=await setup(t);assert.equal((await s.request('select',{ticket:'expired',indices:[0]})).body.code,'login_expired');
  const login=await s.login();assert.equal(login.status,200);assert.ok(!JSON.stringify(login).includes(devicePassword));assert.ok(!JSON.stringify(login).includes(server));
  const r=await s.request('select',{ticket:login.body.ticket,indices:[0],ipHints:{0:'8.8.8.8'}});
  assert.equal(r.body.code,'ip_hint');
  assert.equal((await s.request('select',{ticket:login.body.ticket,indices:[0],ipHints:{}})).status,200);
});
test('failed storage write preserves the saved and in-memory cameras and allows retry',{timeout:12000},async t=>{
  const s=await setup(t,{devices:[valid]},true),before=fs.readFileSync(path.join(s.dir,'bridge.json'));
  const login=await s.login(),selection={ticket:login.body.ticket,indices:[0],ipHints:{}};
  fs.mkdirSync(path.join(s.dir,'bridge.json.tmp'));
  const failed=await s.request('select',selection);assert.equal(failed.body.code,'save_failed');
  assert.deepEqual(fs.readFileSync(path.join(s.dir,'bridge.json')),before);
  assert.equal((await s.request('export?host=127.0.0.1')).body.cameras[0].name,'Original camera');
  assert.equal((await s.request('status')).body.cameras[0].name,'Original camera');
  fs.rmdirSync(path.join(s.dir,'bridge.json.tmp'));
  assert.equal((await s.request('select',selection)).status,200);
  const saved=JSON.parse(fs.readFileSync(path.join(s.dir,'bridge.json')));
  assert.equal(saved.cameras[0].name,'New camera');assert.deepEqual(saved.rtsp,s.original.rtsp);
  assert.ok(!JSON.stringify(saved).includes(accountPassword));assert.ok(!JSON.stringify(saved).includes(login.body.ticket));
});

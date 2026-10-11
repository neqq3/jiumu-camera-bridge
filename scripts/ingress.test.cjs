// SPDX-License-Identifier: Apache-2.0
'use strict';
// Run only in a disposable Linux network namespace with 172.30.32.2 on loopback.
// The application sees a real socket peer; no auth mocks or forwarding bypass.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events');
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(r=>s.close(r));return n;}
test('Ingress socket boundary, relative resources and persisted HAOS options',{timeout:25000},async t=>{
 assert.equal(process.env.INGRESS_SOCKET_TEST,'1','Use the documented isolated Linux test namespace, never alter host interfaces');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-ingress-'));
 fs.writeFileSync(path.join(dir,'options.json'),JSON.stringify({rtsp_port:19554,local_only:false}));
 const apiPort=await port(),mediaPort=await port();let child,ended;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await ended;}fs.rmSync(dir,{recursive:true,force:true});});
 function request(route,source='172.30.32.2',headers={},body){return new Promise((resolve,reject)=>{
  const r=http.request({hostname:'127.0.0.1',port:apiPort,path:route,localAddress:source,method:body?'POST':'GET',headers,timeout:1500},res=>{let data='';res.setEncoding('utf8');res.on('data',s=>data+=s);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:data,json:()=>JSON.parse(data)}));});
  r.on('error',reject);r.on('timeout',()=>r.destroy(Error('request_timeout')));r.end(body);
 });}
 async function start(){child=spawn(process.execPath,[path.resolve(__dirname,'../jiumu_bridge/server.cjs')],{env:{...process.env,DATA_DIR:dir,PORT:String(apiPort),MEDIA_PORT:String(mediaPort),HA_INGRESS:'1',LOCAL_ONLY:'0',DISABLE_GO2RTC:'1'},stdio:['ignore','ignore','pipe']});ended=once(child,'exit');
  for(let i=0;i<60;i++){assert.equal(child.exitCode,null,'server startup');try{if((await request('/api/mode')).status===200)return;}catch{}await new Promise(r=>setTimeout(r,50));}assert.fail('Ingress did not become ready on real Supervisor socket source');}
 await start();
 for(const route of ['/','/app.js','/style.css','/api/mode','/api/status','/api/export?host=192.168.1.20']){
  assert.equal((await request(route,'127.0.0.1')).status,403,route+' rejects direct access');
  assert.equal((await request(route,'127.0.0.1',{'X-Forwarded-For':'172.30.32.2','X-Real-IP':'172.30.32.2','X-Ingress-Path':'/api/hassio_ingress/fake'})).status,403,route+' rejects forged headers');
  assert.equal((await request(route)).status,200,route+' accepts Supervisor');
 }
 assert.deepEqual((await request('/api/mode')).json(),{ingress:true,local_only:false});
 assert.equal((await request('/api/status')).json().rtsp_port,19554);
 for(const route of ['/api/export','/api/export?host=','/api/export?host=https%3A%2F%2Fremote-ha.invalid']){
  const result=await request(route);assert.equal(result.status,400);assert.equal(result.json().code,'export_host');
 }
 const html=(await request('/')).text,base='http://ha.invalid/api/hassio_ingress/synthetic/';
 for(const asset of [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m=>m[1]))assert.ok(new URL(asset,base).pathname.startsWith('/api/hassio_ingress/synthetic/'));
 const post={'Content-Type':'application/json'};
 assert.equal((await request('/api/login','172.30.32.2',post,'{}')).status,403);
 assert.equal((await request('/api/login','172.30.32.2',{...post,'X-Jiumu-Request':'1'},'{}')).json().code,'account_input');
 const before=fs.readFileSync(path.join(dir,'bridge.json')),token=fs.readFileSync(path.join(dir,'admin-token'));
 child.kill('SIGTERM');await ended;await start();
 assert.deepEqual(fs.readFileSync(path.join(dir,'bridge.json')),before,'RTSP credentials survive restart');
 assert.deepEqual(fs.readFileSync(path.join(dir,'admin-token')),token);
 assert.equal((await request('/api/status')).json().rtsp_port,19554);
});

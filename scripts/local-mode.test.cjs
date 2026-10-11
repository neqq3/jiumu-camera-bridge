// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function run(t,env,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-mode-'));
 fs.writeFileSync(path.join(dir,'options.json'),JSON.stringify(options));
 const port=await freePort(),mediaPort=await freePort();
 const child=spawn(process.execPath,[path.resolve(__dirname,'../jiumu_bridge/server.cjs')],{
  env:{...process.env,HA_INGRESS:'0',LOCAL_ONLY:'0',...env,DATA_DIR:dir,PORT:String(port),MEDIA_PORT:String(mediaPort),DISABLE_GO2RTC:'1'},
  stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000);});
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}fs.rmSync(dir,{recursive:true,force:true});});
 const request=(route,init={})=>fetch(`http://127.0.0.1:${port}${route}`,{...init,signal:AbortSignal.timeout(1000)});
 let ready=false;
 for(let i=0;i<60;i++){
  if(child.exitCode!==null)throw Error('test_server_exited: '+stderr);
  try{if((await request('/api/mode')).ok){ready=true;break;}}catch(_){}
  await new Promise(r=>setTimeout(r,50));
 }
 assert.ok(ready,'server became ready');
 return {dir,request,token:fs.readFileSync(path.join(dir,'admin-token'),'utf8').trim()};
}
for(const source of ['environment','HAOS options'])test(`local-only from ${source} rejects cloud routes and preserves state`,{timeout:12000},async t=>{
 const {dir,request,token}=await run(t,source==='environment'?{LOCAL_ONLY:'1'}:{},source==='HAOS options'?{local_only:true}:{});
 assert.deepEqual(await(await request('/api/mode')).json(),{ingress:false,local_only:true});
 const before=fs.readFileSync(path.join(dir,'bridge.json'));
 for(const route of ['/api/login','/api/select']){
  const res=await request(route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Jiumu-Request':'1'},body:'{}'});
  assert.equal(res.status,403);assert.match((await res.json()).error,/仅本地/);
 }
 assert.equal((await request('/api/status')).status,401);
 const res=await request('/api/status',{headers:{Authorization:'Bearer '+token}});
 assert.equal(res.status,200);assert.deepEqual((await res.json()).cameras,[]);
 assert.deepEqual(fs.readFileSync(path.join(dir,'bridge.json')),before);
});
test('default mode retains account onboarding without making a cloud request',{timeout:12000},async t=>{
 const {request,token}=await run(t,{});
 assert.equal((await(await request('/api/mode')).json()).local_only,false);
 const res=await request('/api/select',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Jiumu-Request':'1'},body:'{}'});
 assert.equal(res.status,400);
});

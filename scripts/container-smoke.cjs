// SPDX-License-Identifier: Apache-2.0
'use strict';
// Execute with `docker exec` only in a fresh, disposable --network=none container.
// This test kills its go2rtc child to verify recovery; never run in production.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
assert.equal(process.env.JIUMU_INSTALL_TEST,'1','Disposable installation test required');
const interfaces=fs.readdirSync('/sys/class/net').filter(name=>fs.existsSync('/sys/class/net/'+name+'/ifindex'));
assert.deepEqual(interfaces,['lo'],'No host/LAN network allowed');
const step=process.argv[2]||'check',data='/data';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=(path,init={})=>fetch('http://127.0.0.1:18082'+path,{...init,signal:AbortSignal.timeout(2000)});
const ready=()=>fetch('http://127.0.0.1:18083/ready',{signal:AbortSignal.timeout(2000)});
async function waitReady(){
  const end=Date.now()+15000;
  while(Date.now()<end){try{if((await ready()).status===200)return;}catch{}await delay(100);}
  assert.fail('RTSP never became ready');
}
function rtspPids(){return fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{
  try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('\0-config\0/data/go2rtc.yaml');}catch{return false;}
}).map(Number);}
async function main(){
  if(step==='spawn-recovery'){
    assert.equal(process.env.GO2RTC_BIN,'/data/missing-go2rtc');
    assert.equal((await ready()).status,503,'Missing binary cannot be ready');
    assert.equal(spawnSync('node',['/app/lib/healthcheck.cjs']).status,1);
    fs.symlinkSync('/usr/local/bin/go2rtc','/data/missing-go2rtc');
    await waitReady(); // Failed spawn must retry without restarting the bridge.
  }else await waitReady();
  if(step==='interrupt-rtsp'){
    const before=rtspPids();assert.equal(before.length,1);
    process.kill(before[0],'SIGKILL');
    assert.equal((await ready()).status,503,'RTSP loss must not report ready');
    await waitReady();
    const after=rtspPids();assert.equal(after.length,1);assert.notEqual(after[0],before[0]);
  }
  const key=fs.readFileSync(data+'/admin-token','utf8').trim();
  const headers={Authorization:'Bearer '+key};
  for(const route of ['/','/app.js','/style.css']){
    const response=await get(route);assert.equal(response.status,200);assert.ok((await response.text()).length>50);
  }
  assert.equal((await get('/api/status')).status,401);
  const status=await(await get('/api/status',{headers})).json();
  assert.deepEqual(status.cameras,[]);assert.equal(status.rtsp_ready,true);
  assert.equal(spawnSync('node',['/app/lib/healthcheck.cjs']).status,0);
  // Media health intentionally remains false until a camera is imported.
  assert.equal((await fetch('http://127.0.0.1:18083/health')).status,503);
  const files=['bridge.json','admin-token'],hashes={};
  for(const name of files){
    assert.equal(fs.statSync(data+'/'+name).mode&0o777,0o600);
    hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(data+'/'+name)).digest('hex');
  }
  assert.equal(fs.statSync(data).mode&0o777,0o700);
  const marker=data+'/.install-test-state.json';
  if(fs.existsSync(marker))assert.deepEqual(JSON.parse(fs.readFileSync(marker)),hashes,'Credentials changed on restart');
  else fs.writeFileSync(marker,JSON.stringify(hashes),{mode:0o600});
  const options=fs.existsSync(data+'/options.json')?JSON.parse(fs.readFileSync(data+'/options.json')):{};
  assert.equal(status.rtsp_port,options.rtsp_port||18554);
  const mode=await(await get('/api/mode')).json();assert.equal(mode.local_only,options.local_only===true);
  const response=await get('/api/login',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Jiumu-Request':'1'},body:'{}'});
  assert.equal(response.status,mode.local_only?403:400,'Invalid/disabled login must fail before cloud access');
  console.log(JSON.stringify({passed:true,step,uid:process.getuid(),rtspPort:status.rtsp_port,cameraCount:0,network:'none',credentialsPrinted:false}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

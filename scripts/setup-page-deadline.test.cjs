// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../jiumu_bridge/public/app.js'),'utf8');
// Execute the actual page script with a small DOM and controlled browser timers.
// Fetch is synthetic: no account, camera, server or DNS is contacted.
async function page(){
 const elements=new Map(),timers=new Map();let timerId=0,requests=[],handler;
 function element(){return {hidden:true,value:'',textContent:'',className:'',children:[],buttons:[{disabled:false}],
  replaceChildren(){this.children=[];},append(...nodes){this.children.push(...nodes);},focus(){},setAttribute(){},
  querySelector(){return this.paragraph??=(element());},querySelectorAll(selector){return selector==='button'?this.buttons:[];}};}
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const response=(data,status=200)=>({ok:status<400,status,json:async()=>data,blob:async()=>({})});
 handler=async url=>response(url==='api/mode'?{ingress:false,local_only:false}:{cameras:[]});
 let ready;const initialized=new Promise(resolve=>ready=resolve);
 const context=vm.createContext({document:{getElementById:get,createElement:element,createTextNode:t=>t},
  sessionStorage:{getItem:()=> 'synthetic-local-admin',setItem(){}},location:{hostname:'127.0.0.1'},navigator:{},
  URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},AbortController,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  setInterval(){ready();return 1;},fetch:(url,options={})=>{requests.push(url);return handler(url,options);}});
 vm.runInContext(source,context);await initialized;
 const hanging=signal=>new Promise((_,reject)=>{signal?.addEventListener('abort',()=>reject(new Error('synthetic network abort')),{once:true});});
 return {get,timers,requests,response,hanging,context,
  handle(fn){handler=fn;},async flush(){for(let i=0;i<12;i++)await Promise.resolve();},
  expire(ms){const entry=[...timers].find(([,v])=>v.ms===ms);assert.ok(entry,`missing ${ms}ms request deadline`);timers.delete(entry[0]);entry[1].fn();},
  refresh:()=>vm.runInContext('refresh()',context),api:route=>vm.runInContext(`api(${JSON.stringify(route)})`,context)};
}

test('login body timeout clears the password and enables retry without resubmission',async()=>{
 const p=await page();p.get('password').value='synthetic-account-password';let logins=0;
 p.handle(async(url,opts)=>{assert.equal(url,'api/login');logins++;return {ok:true,json:()=>p.hanging(opts.signal)};});
 const submit=p.get('login').onsubmit({preventDefault(){}});await p.flush();
 assert.equal(p.get('login').buttons[0].disabled,true);
 // The server may spend 15s on lookup, 15s on login and 25s on listing.
 assert.ok(![...p.timers.values()].some(t=>t.ms===10000));p.expire(65000);await submit;
 assert.equal(p.get('password').value,'');assert.equal(p.get('login').buttons[0].disabled,false);
 assert.match(p.get('message').textContent,/超时/);assert.equal(logins,1);assert.equal(p.timers.size,0);
 p.handle(async()=>p.response({ticket:'synthetic-ticket',devices:[]}));
 await p.get('login').onsubmit({preventDefault(){}});
 assert.equal(p.get('choose').hidden,false);assert.equal(p.get('save-selection').disabled,true);
 assert.match(p.get('message').textContent,/没有摄像头/);
});

test('hung status body releases refresh so a later poll can recover',async()=>{
 const p=await page();p.handle(async(_url,opts)=>({ok:true,json:()=>p.hanging(opts.signal)}));
 const refresh=p.refresh();await p.flush();p.expire(10000);await refresh;
 assert.match(p.get('message').textContent,/超时/);
 const before=p.requests.length;p.handle(async()=>p.response({cameras:[]}));await p.refresh();
 assert.equal(p.requests.length,before+1);assert.equal(p.timers.size,0);
});

test('hung snapshot does not permanently stop status polling',async()=>{
 const p=await page();p.handle(async(url,opts)=>url.startsWith('api/snapshot/')?p.hanging(opts.signal):p.response({cameras:[{id:'synthetic-camera',name:'Test camera',fresh:true,audio_fresh:true,reconnects:0}]}));
 const refresh=p.refresh();await p.flush();p.expire(5000);await refresh;
 assert.equal(p.get('preview').hidden,true);assert.equal(p.get('empty').hidden,false);
 const before=p.requests.length;p.handle(async()=>p.response({cameras:[]}));await p.refresh();
 assert.equal(p.requests.length,before+1);assert.equal(p.timers.size,0);
});

test('successful and invalid responses clean up timers and preserve safe errors',async()=>{
 const p=await page();await p.api('status');assert.equal(p.timers.size,0);
 p.handle(async()=>({ok:true,json:async()=>{throw Error('synthetic-private-server-detail');}}));
 await assert.rejects(p.api('status'),/桥接服务返回异常/);assert.equal(p.timers.size,0);
 p.handle(async()=>p.response({error:'请重新登录',code:'login_expired'},400));
 await assert.rejects(p.api('select'),e=>e.code==='login_expired'&&e.message==='请重新登录');assert.equal(p.timers.size,0);
});

'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {CameraSession}=require('./lib/session.cjs');
const {network,identity}=require('./lib/hlp-crypto.cjs');
const {isLan}=require('./lib/hlp-client.cjs');
const {frigateInputArgs,mediaSources}=require('./lib/transcode.cjs');
const {SetupError,setupResponse}=require('./lib/setup-errors.cjs');
process.umask(0o077);
const dataDir=process.env.DATA_DIR||'/data';fs.mkdirSync(dataDir,{recursive:true,mode:0o700});fs.chmodSync(dataDir,0o700);
const file=path.join(dataDir,'bridge.json');
function atomic(name,value){const dest=path.join(dataDir,name);fs.writeFileSync(dest+'.tmp',value,{mode:0o600});fs.chmodSync(dest+'.tmp',0o600);fs.renameSync(dest+'.tmp',dest);fs.chmodSync(dest,0o600);}
let options={};try{options=JSON.parse(fs.readFileSync(path.join(dataDir,'options.json')));}catch(_){}
const ha=process.env.HA_INGRESS==='1',port=Number(process.env.PORT||18082),mediaPort=Number(process.env.MEDIA_PORT||18083);
const localOnly=process.env.LOCAL_ONLY==='1'||options.local_only===true;
const rtspPort=Number(process.env.RTSP_PORT||options.rtsp_port||18554),goApiPort=Number(process.env.GO2RTC_API_PORT||18084);
let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{version:1,cameras:[],rtsp:{username:'viewer',password:crypto.randomBytes(18).toString('hex')}};
if(!fs.existsSync(file))atomic('bridge.json',JSON.stringify(state));
const tokenFile=path.join(dataDir,'admin-token');
if(!fs.existsSync(tokenFile))atomic('admin-token',crypto.randomBytes(24).toString('hex'));
const adminToken=fs.readFileSync(tokenFile,'utf8').trim();
fs.chmodSync(tokenFile,0o600);fs.chmodSync(file,0o600);
const sessions=new Map(),pending=new Map();let shutdown=false,goChild,goTimer,loginBusy=false,lastLogin=0;
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function json(res,code,value){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
function authorized(req){return ha?req.socket.remoteAddress==='172.30.32.2':equal(req.headers.authorization,'Bearer '+adminToken);}
async function body(req) {
  if(!String(req.headers['content-type']).startsWith('application/json'))throw new Error('请使用 JSON 请求');
  let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>8192)throw new Error('请求过大');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks));}catch(_){throw new Error('请求格式错误');}
}
function startCamera(c){network(c.config.server);identity(c.config.did);sessions.set(c.id,new CameraSession(c));}
function goConfig() {
  const streams={};for(const c of state.cameras) {
    const base=`http://127.0.0.1:${mediaPort}/cameras/${c.id}`;
    streams[c.id]=mediaSources(base);
  }
  // JSON is also valid YAML. Credentials stay in the private data volume.
  return JSON.stringify({api:{listen:`127.0.0.1:${goApiPort}`},rtsp:{listen:`:${rtspPort}`,...state.rtsp},
    webrtc:{listen:''},streams,log:{level:'error'}},null,2);
}
function startGo() {
  if(shutdown || process.env.DISABLE_GO2RTC==='1')return;
  atomic('go2rtc.yaml',goConfig());
  goChild=spawn(process.env.GO2RTC_BIN||'/usr/local/bin/go2rtc',['-config',path.join(dataDir,'go2rtc.yaml')],{stdio:'ignore'});
  goChild.on('error',()=>console.error('RTSP service could not start; verify go2rtc installation'));
  goChild.on('exit',()=>{goChild=null;if(!shutdown)goTimer=setTimeout(startGo,2000);});
}
function refreshGo(){if(goChild)goChild.kill('SIGTERM');else {clearTimeout(goTimer);startGo();}}
function safeHost(value) {
  const valueString=String(value||'').trim();
  if(!/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(valueString))throw new SetupError('export_host');return valueString.split(':')[0];
}
function exportsFor(host) {
  const password=encodeURIComponent(state.rtsp.password),user=encodeURIComponent(state.rtsp.username);
  return state.cameras.map(c=>{
    const url=`rtsp://${user}:${password}@${host}:${rtspPort}/${c.id}`;
    return {id:c.id,name:c.name,rtsp:url,username:state.rtsp.username,password:state.rtsp.password,
      frigate:`go2rtc:\n  streams:\n    ${c.id}:\n      - ${JSON.stringify(url)}\ncameras:\n  ${c.id}:\n    ffmpeg:\n      inputs:\n        - path: rtsp://127.0.0.1:8554/${c.id}\n          input_args: ${JSON.stringify(frigateInputArgs)}\n          roles: [detect]\n        - path: rtsp://127.0.0.1:8554/${c.id}\n          input_args: ${JSON.stringify(frigateInputArgs)}\n          roles: [record]\n      output_args:\n        record: preset-record-generic-audio-copy\n    detect:\n      width: 640\n      height: 480\n      fps: 5\n    record:\n      enabled: true\n`};
  });
}
const api=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'");
  const url=new URL(req.url,'http://localhost'),route=url.pathname;
  if(ha&&req.socket.remoteAddress!=='172.30.32.2')return json(res,403,{error:'仅允许 Home Assistant Ingress 访问'});
  if(req.method==='GET'&&['/','/app.js','/style.css'].includes(route)) {
    const name=route==='/'?'index.html':route.slice(1),type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html';
    res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store'});return fs.createReadStream(path.join(__dirname,'public',name)).pipe(res);
  }
  if(req.method==='GET'&&route==='/api/mode')return json(res,200,{ingress:ha,local_only:localOnly});
  if(!authorized(req))return json(res,401,{error:'请填写本地管理密钥'});
  // JSON + a custom header prevents cross-site form submissions; never trust forwarded IP headers.
  if(req.method==='POST'&&req.headers['x-jiumu-request']!=='1')return json(res,403,{error:'请求来源验证失败'});
  if(localOnly&&['/api/login','/api/select'].includes(route))return json(res,403,{error:'仅本地模式已禁用厂商账号导入；现有摄像头凭据仍可用于局域网连接'});
  try {
    if(req.method==='GET'&&route==='/api/status')return json(res,200,{cameras:[...sessions.values()].map(s=>s.status()),rtsp_port:rtspPort,rtsp_ready:!!goChild});
    if(req.method==='GET'&&route==='/api/export')return json(res,200,{cameras:exportsFor(safeHost(url.searchParams.get('host')??(ha?'':req.headers.host)))});
    const snap=/^\/api\/snapshot\/([a-z0-9_]+)$/.exec(route);
    if(req.method==='GET'&&snap){const s=sessions.get(snap[1]);if(!s)return json(res,404,{error:'摄像头不存在'});return s.serve(res,'snapshot.jpg');}
    if(req.method==='POST'&&route==='/api/login') {
      if(loginBusy||Date.now()-lastLogin<10000)return json(res,429,{error:'请等待上次登录完成，稍后重试'});
      const input=await body(req);
      if(typeof input.account!=='string'||typeof input.password!=='string'||!input.account.trim()||!input.password||input.account.length>256||input.password.length>256)throw new SetupError('account_input');
      loginBusy=true;lastLogin=Date.now();
      try {
        const devices=await require('./lib/onboarding.cjs').onboard(input.account.trim(),input.password);input.password='';
        const ticket=crypto.randomBytes(24).toString('hex');pending.clear();pending.set(ticket,{devices,expires:Date.now()+600000});
        return json(res,200,{ticket,devices:devices.map((d,index)=>({index,name:d.name,supported:d.supported,...(!d.supported?{reason:d.reason}:{} )}))});
      } catch(error){return json(res,502,setupResponse(error,'cloud_response'));}finally{loginBusy=false;input.password='';}
    }
    if(req.method==='POST'&&route==='/api/select') {
      const input=await body(req),entry=pending.get(input.ticket);
      if(!entry||entry.expires<Date.now())throw new SetupError('login_expired');
      if(!Array.isArray(input.indices)||!input.indices.length||input.indices.length>4||new Set(input.indices).size!==input.indices.length)throw new SetupError('selection');
      const next=input.indices.map(index=>{
        const d=entry.devices[index];if(!Number.isInteger(index)||!d?.supported||!d.config)throw new SetupError('device_unavailable');
        network(d.config.server);identity(d.config.did);
        const ipHint=String(input.ipHints?.[index]||'');if(ipHint&&!isLan(ipHint))throw new SetupError('ip_hint');
        return {id:'camera_'+crypto.createHash('sha256').update(d.config.did).digest('hex').slice(0,8),name:String(d.name).slice(0,100),
          config:{did:d.config.did,server:d.config.server,user:d.config.user,password:d.config.password},ipHint};
      });
      const nextState={...state,cameras:next};
      try{atomic('bridge.json',JSON.stringify(nextState,null,2));}catch(_){throw new SetupError('save_failed');}
      state=nextState;
      for(const s of sessions.values())s.stop();sessions.clear();for(const c of state.cameras)startCamera(c);
      pending.clear();refreshGo();return json(res,200,{saved:next.length});
    }
    json(res,404,{error:'没有此接口'});
  } catch(error){json(res,400,setupResponse(error));}
});
api.requestTimeout=40000;api.headersTimeout=15000;api.listen(port,'0.0.0.0');
const media=http.createServer((req,res)=>{
  if(req.url==='/health'){const items=[...sessions.values()].map(s=>s.status());return json(res,items.length&&items.every(s=>s.fresh)?200:503,{cameras:items});}
  const m=/^\/cameras\/([a-z0-9_]+)\/(snapshot.jpg|stream.mjpeg|audio.wav)$/.exec(req.url);
  if(!m||!sessions.has(m[1])){res.writeHead(404);res.end();return;}sessions.get(m[1]).serve(res,m[2]);
});
media.listen(mediaPort,'127.0.0.1');
for(const c of state.cameras)startCamera(c);startGo();
const cleanup=setInterval(()=>{for(const [id,e]of pending)if(e.expires<Date.now())pending.delete(id);},60000);
console.log(`Jiumu Bridge ready; setup port ${port}; RTSP port ${rtspPort}; Android is not used`);
if(!ha)console.log('Read /data/admin-token inside the container to unlock the local setup page');
function stop(){if(shutdown)return;shutdown=true;clearInterval(cleanup);clearTimeout(goTimer);for(const s of sessions.values())s.stop();if(goChild)goChild.kill('SIGTERM');api.close();media.close();setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);

'use strict';
const $=id=>document.getElementById(id);let token=sessionStorage.getItem('jiumu-admin')||'',ticket='',selected='',busy=false,blobUrl;
const msg=text=>{$('message').textContent=text;};
async function api(route,body) {
 const res=await fetch('api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Jiumu-Request':'1'},body:body?JSON.stringify(body):undefined});
 const data=await res.json();if(!res.ok)throw new Error(data.error||'连接失败，请重试');return data;
}
function lock(form,value){form.querySelectorAll('button').forEach(b=>b.disabled=value);}
$('unlock').onsubmit=async e=>{e.preventDefault();token=$('key').value;try{await api('status');sessionStorage.setItem('jiumu-admin',token);$('key').value='';$('unlock').hidden=true;msg('');await refresh();}catch(e){msg(e.message);}};
$('login').onsubmit=async e=>{
 e.preventDefault();lock($('login'),true);msg('正在登录并读取设备列表…');
 try{const result=await api('login',{account:$('account').value,password:$('password').value});ticket=result.ticket;$('password').value='';$('devices').replaceChildren();
 for(const d of result.devices){const row=document.createElement('div');row.className='choice';const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=d.index;check.disabled=!d.supported;check.checked=d.supported&&result.devices.filter(x=>x.supported).length===1;label.append(check,document.createTextNode(d.name));row.append(label);
 const note=document.createElement('small');note.textContent=d.supported?'可使用本地协议连接':'此设备协议暂未支持';row.append(note);
 if(d.supported){const ip=document.createElement('input');ip.type='text';ip.dataset.index=d.index;ip.placeholder='摄像头 IP（可选，默认自动发现）';ip.setAttribute('aria-label',d.name+' 的可选局域网 IP');row.append(ip);}$('devices').append(row);}
 $('login').hidden=true;$('choose').hidden=false;msg(result.devices.length?'请选择需要接入的摄像头。':'账号内没有摄像头，请先在 APP 中绑定。');
 }catch(e){msg(e.message);}finally{$('password').value='';lock($('login'),false);}
};
$('choose').onsubmit=async e=>{e.preventDefault();const indices=[...$('devices').querySelectorAll('input:checked')].map(x=>Number(x.value));if(!indices.length)return msg('请至少选择一台摄像头。');const ipHints={};$('devices').querySelectorAll('[data-index]').forEach(x=>ipHints[x.dataset.index]=x.value.trim());lock($('choose'),true);
 try{await api('select',{ticket,indices,ipHints});$('choose').hidden=true;ticket='';msg('已保存，正在通过局域网连接。');await refresh();}catch(e){msg(e.message);}finally{lock($('choose'),false);}};
$('back').onclick=()=>{$('choose').hidden=true;$('login').hidden=false;};
$('replace').onclick=()=>{$('login').hidden=false;$('choose').hidden=true;$('account').focus();};
async function preview(){if(!selected)return;try{const r=await fetch('api/snapshot/'+selected,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error();const next=URL.createObjectURL(await r.blob());$('preview').src=next;$('preview').hidden=false;$('empty').hidden=true;if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=next;}catch(_){$('preview').hidden=true;$('empty').hidden=false;$('empty').querySelector('p').textContent='等待摄像头的新画面';}}
async function refresh(){if(busy||!$('unlock').hidden)return;busy=true;try{
 const s=await api('status');$('outputs').hidden=!s.cameras.length;$('saved').hidden=!s.cameras.length||!$('login').hidden||!$('choose').hidden;
 if(!s.cameras.length&&$('choose').hidden)$('login').hidden=false;
 $('cameras').replaceChildren();for(const c of s.cameras){const row=document.createElement('div');row.className='camera-row';const content=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=c.name;detail.textContent=(c.fresh?'画面在线':'正在连接')+' · '+(c.audio_fresh?'声音在线':'等待声音')+' · 重连 '+c.reconnects;content.append(name,detail);const button=document.createElement('button');button.className='secondary';button.textContent='预览';button.onclick=()=>{selected=c.id;preview();};row.append(content,button);$('cameras').append(row);}
 if(!s.cameras.some(c=>c.id===selected))selected=s.cameras[0]?.id||'';
 const active=s.cameras.find(c=>c.id===selected);$('summary').textContent=active?.fresh?'实时 · 局域网':'等待连接';$('summary').className='badge'+(active?.fresh?' live':'');if(active?.fresh&&$('message').textContent==='已保存，正在通过局域网连接。')msg('已连接，重启服务后会自动恢复。');await preview();
 }catch(e){msg(e.message);}finally{busy=false;}}
$('host').value=location.hostname;
$('export').onclick=async()=>{try{const data=await api('export?host='+encodeURIComponent($('host').value));$('exports').replaceChildren();for(const c of data.cameras){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=c.name+' · 接入配置（含本地取流密码）';details.append(summary);
 const tip=document.createElement('p');tip.className='help';tip.textContent='Frigate：合并下面的 go2rtc 与 cameras 条目，保留原有配置。HA：添加 Generic Camera，将 RTSP 地址填入流来源，选择 TCP。';details.append(tip);
 for(const [label,value,cls]of [['RTSP 地址',c.rtsp,'rtsp'],['Frigate 配置',c.frigate,'']]){const text=document.createElement('textarea');text.readOnly=true;text.value=value;text.className=cls;text.setAttribute('aria-label',label);details.append(text);const copy=document.createElement('button');copy.className='secondary';copy.textContent='复制'+label;copy.onclick=async()=>{try{await navigator.clipboard.writeText(value);msg('已复制'+label);}catch(_){text.select();msg('浏览器不允许自动复制，已选中内容，请手动复制。');}};details.append(copy);}$('exports').append(details);}}catch(e){msg(e.message);}};
(async()=>{try{const m=await(await fetch('api/mode')).json();$('unlock').hidden=m.ingress||!!token;if($('unlock').hidden)try{await api('status');await refresh();}catch(_){$('unlock').hidden=false;}setInterval(refresh,3000);}catch(_){msg('桥接服务无法访问，请检查服务是否已启动。');}})();

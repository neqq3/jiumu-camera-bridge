// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='.git'?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const files=walk(root);let scripts=0,links=0;
for(const file of files){
 if(/\.(?:cjs|js)$/.test(file)){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(result.status,0,'JavaScript syntax failed: '+path.relative(root,file));scripts++;
 }
 if(file.endsWith('.md'))for(const match of fs.readFileSync(file,'utf8').matchAll(/\]\(([^\s)]+)\)/g)){
  const target=match[1];if(/^[a-z]+:|^#/.test(target))continue;
  const resolved=path.resolve(path.dirname(file),decodeURIComponent(target.split('#')[0]));
  assert.ok(resolved.startsWith(root+path.sep),'Link outside repository');
  assert.ok(fs.existsSync(resolved),'Broken local link: '+path.relative(root,file));links++;
 }
}
const modules=['hlp-client','hlp-crypto','media','session','transcode','onboarding','onboarding_crypto','binding-codec','binding-lock','binding-state','binding-service'];
for(const name of modules)require('../jiumu_bridge/lib/'+name+'.cjs');
console.log(JSON.stringify({syntaxChecked:scripts,localLinksChecked:links,modulesLoaded:modules.length,networkAccess:false}));

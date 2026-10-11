// SPDX-License-Identifier: Apache-2.0
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {openState}=require('../jiumu_bridge/lib/binding-state.cjs');
const target={did:'TEST-CRASH-RECOVERY',uid:'test-owner'};
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiumu-lock-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Linux kernel lock rejects a competing writer and releases after SIGKILL without changing saved credentials',
 {skip:process.platform!=='linux',timeout:10000},async t=>{
  const dir=temp(t),modulePath=require.resolve('../jiumu_bridge/lib/binding-state.cjs');
  const child=spawn(process.execPath,['-e',`
    const s=require(process.env.TEST_MODULE).openState(process.env.TEST_DIR,JSON.parse(process.env.TEST_TARGET));
    s.prepareDelivery('test-owner');process.send('ready');setInterval(()=>{},1000);
  `],{env:{...process.env,TEST_MODULE:modulePath,TEST_DIR:dir,TEST_TARGET:JSON.stringify(target)},stdio:['ignore','ignore','pipe','ipc']});
  const exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}});
  const ready=await Promise.race([once(child,'message'),exit.then(()=>{throw Error('lock_child_failed');})]);
  assert.equal(ready[0],'ready');
  const file=path.join(dir,'binding-state.json'),before=fs.readFileSync(file);
  assert.throws(()=>openState(dir,target),/state_guard_unavailable/);
  child.kill('SIGKILL');await exit;
  const recovered=openState(dir,target);
  assert.ok(recovered.attempted);assert.deepEqual(fs.readFileSync(file),before);
  assert.throws(()=>recovered.prepareDelivery('test-owner'),/already_attempted/);
  recovered.close();recovered.close();
  assert.ok(fs.existsSync(path.join(dir,'binding.guard')));
  const next=openState(dir,target);next.close();assert.deepEqual(fs.readFileSync(file),before);
 });
test('Linux refuses an unresolved legacy marker instead of deleting it', {skip:process.platform!=='linux'},t=>{
 const dir=temp(t),marker=path.join(dir,'binding.lock');fs.writeFileSync(marker,'');
 assert.throws(()=>openState(dir,target),/legacy_state_lock_requires_review/);
 assert.ok(fs.existsSync(marker));assert.equal(fs.existsSync(path.join(dir,'binding-state.json')),false);
});

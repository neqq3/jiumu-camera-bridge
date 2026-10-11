// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');

function acquireLock(directory) {
  const legacy=path.join(directory,'binding.lock');
  if(process.platform!=='linux') {
    const fd=fs.openSync(legacy,'wx',0o600);fs.closeSync(fd);
    let closed=false;
    return ()=>{if(!closed){closed=true;fs.unlinkSync(legacy);}};
  }
  // Old releases used an existence-only marker. Require a stopped/cleanly
  // migrated old service instead of guessing whether that marker is stale.
  if(fs.existsSync(legacy))throw new Error('legacy_state_lock_requires_review');
  const file=path.join(directory,'binding.guard');
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  try {
    if(!fs.fstatSync(fd).isFile())throw new Error('invalid_state_guard');
    // fd 3 shares this open-file description. flock's child may exit while
    // the parent descriptor retains the kernel lock, including across exec.
    const result=spawnSync('flock',['--exclusive','--nonblock','--conflict-exit-code','73','3'],
      {stdio:['ignore','ignore','ignore',fd],timeout:3000});
    if(result.error || result.status!==0)throw new Error('state_guard_unavailable');
  } catch(error) {fs.closeSync(fd);throw error;}
  let closed=false;
  // Keep the inode. Unlinking a flock file can let another process lock a
  // different inode at the same path while the first process is still alive.
  return ()=>{if(!closed){closed=true;fs.closeSync(fd);}};
}
module.exports={acquireLock};

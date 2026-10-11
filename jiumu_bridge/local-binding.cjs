// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {startBindingService} = require('./lib/binding-service.cjs');

async function main() {
  if (process.argv.length !== 3) throw new Error('configuration_required');
  const file = path.resolve(process.argv[2]);
  if (fs.statSync(file).size > 16384) throw new Error('configuration_too_large');
  const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const base = path.dirname(file);
  const materialPath = path.resolve(base, c.materialFile);
  if (fs.statSync(materialPath).size > 4096) throw new Error('material_too_large');
  const m = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
  if (m.profile !== 'bk7252n-21.120.101.42' || c.target?.firmware !== '21.120.101.42' ||
      !/^[a-f0-9]{64}$/.test(m.keyHex) || !/^[a-f0-9]{32}$/.test(m.ivHex)) throw new Error('invalid_profile');
  c.key = Buffer.from(m.keyHex, 'hex'); c.iv = Buffer.from(m.ivHex, 'hex');
  if (c.allowP2pBootstrap === true) {
    if (!m.p2pBootstrap || typeof m.p2pBootstrap !== 'object') throw new Error('p2p_material_required');
    c.p2pBootstrap = m.p2pBootstrap;
  }
  c.dataDir = path.resolve(base, c.dataDir);
  const service = await startBindingService(c, value => process.stdout.write(JSON.stringify(value) + '\n'));
  const healthFile=path.join(os.tmpdir(),'jiumu-binding-health.json');
  const health=()=>{
    const next=healthFile+'.tmp';
    fs.writeFileSync(next,JSON.stringify({at:Date.now(),...service.status()}),{mode:0o600});
    fs.renameSync(next,healthFile);
  };
  health();const healthTimer=setInterval(health,10000);healthTimer.unref();
  process.stdout.write(JSON.stringify({event: 'listening', mode: c.mode ?? 'observe', ...service.addresses}) + '\n');
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    clearInterval(healthTimer);try{fs.unlinkSync(healthFile);}catch{}
    await service.close();
    process.stdout.write(JSON.stringify({event: 'stopped', ...service.status()}) + '\n');
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
if (require.main === module) main().catch(() => {
  // Error objects may contain config paths or parsed values; never dump them.
  process.stderr.write('Local binding service failed. Check configuration, private state lock and listening ports.\n');
  process.exitCode = 1;
});

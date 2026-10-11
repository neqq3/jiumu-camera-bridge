// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {same} = require('./binding-codec.cjs');
const {acquireLock} = require('./binding-lock.cjs');

function atomicPrivateWrite(file, value) {
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    // Directory fsync is unavailable on Windows. Protect the data directory with ACLs there.
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function openState(directory, target) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const unlock=acquireLock(directory);
  const file = path.join(directory, 'binding-state.json');
  try {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex');
    let state;
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 4096) throw new Error('invalid_state');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schema !== 1 || !same(state.fingerprint, fingerprint) ||
          !/^[a-f0-9]{24}$/.test(state.token) ||
          !(state.deviceCode === null || (typeof state.deviceCode === 'string' && /^[A-Za-z0-9.-]{1,23}$/.test(state.deviceCode))) ||
          !['idle', 'delivery-attempted'].includes(state.status) ||
          (state.status === 'delivery-attempted' && !/^[a-f0-9]{24}$/.test(state.password))) {
        throw new Error('invalid_state');
      }
    } else {
      state = {schema: 1, fingerprint, token: crypto.randomBytes(12).toString('hex'), deviceCode: target.code ?? null, status: 'idle'};
      atomicPrivateWrite(file, state);
    }
    let closed = false;
    return {
      get token() { return state.token; },
      get deviceCode() { return state.deviceCode; },
      get attempted() { return state.status !== 'idle'; },
      pinDeviceCode(value) {
        if (closed || typeof value !== 'string' || !/^[A-Za-z0-9.-]{1,23}$/.test(value)) return false;
        if (state.deviceCode !== null) return same(state.deviceCode, value);
        const next = {...state, deviceCode: value};
        atomicPrivateWrite(file, next); state = next;
        return true;
      },
      prepareDelivery(uid) {
        if (closed || state.status !== 'idle') throw new Error('already_attempted');
        const next = {...state, status: 'delivery-attempted', uid,
          password: crypto.randomBytes(12).toString('hex'), attemptedAt: new Date().toISOString(),
          cameraAccepted: false, videoVerified: false};
        // Persist before socket.write. A crash/failed write must not rotate the password on retry.
        // Even if fsync fails after rename, do not allow another attempt in this process.
        state = next;
        atomicPrivateWrite(file, next);
        return next.password;
      },
      close() { if (!closed) { closed = true; unlock(); } },
    };
  } catch (error) { unlock(); throw error; }
}
module.exports = {openState};

'use strict';
// Reproduced from the supplied app's AppCrypto.decrypt, then checked against
// the actual SDK password. No native library or Android installation required.
const crypto = require('node:crypto');

function decryptDevicePassword(userId, ciphertext) {
  if (!/^\d+$/.test(String(userId)) || !/^(?:[0-9a-f]{32})+$/i.test(ciphertext || '')) {
    throw new Error('Invalid encrypted device credential format');
  }
  const key = crypto.createHash('md5').update(String(userId) + '_+Vstarcam++20200715', 'utf8').digest();
  try {
    const decoder = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
    const plaintext = Buffer.concat([decoder.update(Buffer.from(ciphertext, 'hex')), decoder.final()]);
    if (!plaintext.length || plaintext.length > 256 || !/^[\x21-\x7e]+$/.test(plaintext.toString('utf8'))) {
      throw new Error('Invalid plaintext');
    }
    return plaintext.toString('utf8');
  } catch (_) {
    throw new Error('Device credential could not be decrypted for this account');
  }
}

function deviceConfig(userId, device, {bind = '127.0.0.1', port = 18081} = {}) {
  if (!device || Number(device.p2p?.type) !== 26 || !device.p2p.did || !device.p2p.address) {
    throw new Error('This camera transport has not been validated by this adapter');
  }
  const encrypted = device.security || device.info?.securityPwd || device.info?.security;
  return {
    did: device.p2p.did, extra: '', mode: 26, type: 1, server: device.p2p.address,
    ips: '', user: 'admin', password: decryptDevicePassword(userId, encrypted),
    startCommand: 'livestream.cgi?streamid=10&substream=1&',
    keepAliveCommand: 'trans_cmd_string.cgi?cmd=2131&command=1&DevActiveTime=10&',
    audioStartCommand: 'audiostream.cgi?streamid=1&adpcm_ver=1&', bind, port,
  };
}

function properties(config) {
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/[\r\n]/g, c => c === '\n' ? '\\n' : '\\r')
    .replace(/^ /, '\\ ');
  return Object.entries(config).map(([key,value]) => `${key}=${escape(value)}\n`).join('');
}

module.exports = {decryptDevicePassword, deviceConfig, properties};

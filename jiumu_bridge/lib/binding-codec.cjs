// SPDX-License-Identifier: Apache-2.0
'use strict';
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const MAX_CIPHER = 8192;
const fail = () => { throw new Error('invalid_protocol_data'); };

function createCodec(key, iv) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(iv) || iv.length !== 16) fail();
  key = Buffer.from(key); iv = Buffer.from(iv);
  function encrypt(plain) {
    if (!Buffer.isBuffer(plain) || plain.length > MAX_CIPHER - 1) fail();
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([c.update(plain), c.final()]);
  }
  function decrypt(cipher) {
    if (!cipher.length || cipher.length > MAX_CIPHER || cipher.length % 16) fail();
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([d.update(cipher), d.final()]);
    } catch { fail(); }
  }
  function frame(event, body) {
    if (!Number.isInteger(event) || event < 0 || event > 65535) fail();
    const plain = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const encrypted = plain.length ? encrypt(plain) : plain;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0x12345678);
    header.writeUInt16LE(event, 4);
    header.writeUInt16LE(encrypted.length, 6);
    return Buffer.concat([header, encrypted]);
  }
  function parser(onFrame) {
    // Fixed storage: a partial frame can never grow beyond the firmware limit.
    const buf = Buffer.alloc(MAX_CIPHER + 8);
    let used = 0, needed = 8, poisoned = false;
    return {
      get pending() { return used; },
      push(chunk) {
        if (poisoned || !Buffer.isBuffer(chunk)) fail();
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const n = Math.min(needed - used, chunk.length - offset);
            chunk.copy(buf, used, offset, offset + n); used += n; offset += n;
            if (used !== needed) continue;
            if (needed === 8) {
              const length = buf.readUInt16LE(6);
              if (buf.readUInt32LE() !== 0x12345678 || length > MAX_CIPHER || length % 16) fail();
              needed = 8 + length;
              if (length) continue;
            }
            const event = buf.readUInt16LE(4);
            const plain = needed > 8 ? decrypt(buf.subarray(8, needed)) : Buffer.alloc(0);
            used = 0; needed = 8;
            onFrame(event, plain);
          }
        } catch { poisoned = true; fail(); }
      },
    };
  }
  function fromBase64(value) {
    if (typeof value !== 'string' || value.length > 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
    return decrypt(Buffer.from(value, 'base64'));
  }
  return {encrypt, decrypt, frame, parser, fromBase64};
}
function parseObject(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') fail();
    return value;
  } catch { fail(); }
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
module.exports = {createCodec, parseObject, same, MAX_CIPHER};

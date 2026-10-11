// SPDX-License-Identifier: Apache-2.0
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');
const {createCodec} = require('../jiumu_bridge/lib/binding-codec.cjs');
const {startBindingService, validateConfig} = require('../jiumu_bridge/lib/binding-service.cjs');
const closers = new Map();

// Independently encoded synthetic client; no production codec on the client side.
const key = Buffer.alloc(32, 0x42), iv = Buffer.alloc(16, 0x24);
function enc(bytes) {
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([c.update(bytes), c.final()]);
}
function dec(bytes) {
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(bytes), d.final()]);
}
function wire(event, body) {
  const payload = enc(Buffer.from(JSON.stringify(body)));
  const head = Buffer.from('7856341200000000', 'hex');
  head.writeUInt16LE(event, 4); head.writeUInt16LE(payload.length, 6);
  return Buffer.concat([head, payload]);
}
function temp(t) {
  const base = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'jiumu-binding-test-'));
  closers.set(dir, []);
  t.after(async () => {
    for (const close of closers.get(dir)) await close();
    closers.delete(dir);
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('jiumu-binding-test-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  return dir;
}
const target = {sourceIp: '127.0.0.1', did: 'TEST-CAMERA-ONLY', code: 'test-device-code', firmware: '21.120.101.42', uid: 'local-test-owner'};
function config(t, extra = {}) {
  return {key, iv, dataDir: temp(t), advertiseIp: '127.0.0.1', target: {...target}, httpPort: 0, tcpPort: 0, ...extra};
}
async function run(t, c) {
  const logs = [];
  const s = await startBindingService(c, x => logs.push(x));
  closers.get(c.dataDir).push(() => s.close());
  return {...s, logs};
}
function request(s, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({host: '127.0.0.1', port: s.addresses.http.port, path: '/node/query', method: 'POST', agent: false,
      headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}, ...options}, res => {
      let bytes = '';
      res.on('data', chunk => bytes += chunk);
      res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(bytes), headers: res.headers}));
    });
    req.setTimeout(2000, () => req.destroy(new Error('test_timeout')));
    req.on('error', reject); req.end(data);
  });
}
function bootstrapBody(override = {}) {
  return {did: target.did, code: target.code, secret: enc(Buffer.from(target.did + '_' + target.code)).toString('base64'), ...override};
}
async function bootstrap(s) {
  const result = await request(s, bootstrapBody());
  assert.equal(result.status, 200);
  return result.body.token;
}
async function client(t, s, sourceIp = '127.0.0.1') {
  const socket = net.connect({host: '127.0.0.1', port: s.addresses.tcp.port, localAddress: sourceIp});
  t.after(() => socket.destroy());
  const closed = new Promise(resolve => socket.on('close', resolve));
  socket.on('error', () => {});
  let buffer = Buffer.alloc(0), queue = [], waiters = [];
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt16LE(6)) {
      assert.equal(buffer.readUInt32LE(), 0x12345678);
      const n = buffer.readUInt16LE(6), event = buffer.readUInt16LE(4);
      const payload = buffer.subarray(8, 8 + n);
      const frame = {event, body: n ? JSON.parse(dec(payload).toString()) : null};
      buffer = buffer.subarray(8 + n);
      if (waiters.length) waiters.shift()(frame); else queue.push(frame);
    }
  });
  await once(socket, 'connect');
  return {socket, closed, queue, send: (event, body) => socket.write(wire(event, body)),
    read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test_read_timeout')), 1500);
      waiters.push(frame => { clearTimeout(timer); resolve(frame); });
    })};
}
function registration(token, extra = {}) {
  return {did: target.did, code: target.code, version: target.firmware, uid: target.uid, token, state: 'wait', onlineReason: 0, ...extra};
}
test('framing accepts bytewise splits and coalescing; rejects invalid header, size, padding and UTF-8 at service boundary', () => {
  const codec = createCodec(key, iv), received = [];
  const parser = codec.parser((event, body) => received.push([event, body.toString()]));
  const batch = Buffer.concat([wire(1, {hello: 1}), wire(0, {}), wire(3, {code: '123456'})]);
  for (const byte of batch) parser.push(Buffer.from([byte]));
  assert.equal(parser.pending, 0); assert.deepEqual(received.map(x => x[0]), [1, 0, 3]);
  parser.push(batch); assert.equal(received.length, 6);
  const oversized = Buffer.from('7856341203001020', 'hex');
  const badPadding = wire(3, {code: 'long enough for two blocks'});
  badPadding[badPadding.length - 17] ^= 0x80;
  for (const bad of [Buffer.alloc(8), oversized, Buffer.from('7856341203000100', 'hex'), badPadding]) {
    const p = codec.parser(() => assert.fail('bad packet accepted'));
    assert.throws(() => p.push(bad)); assert.throws(() => p.push(wire(0, {})));
  }
  assert.throws(() => codec.frame(3, Buffer.alloc(8192)));
  assert.throws(() => codec.fromBase64('!!!!'));
  let empty;
  codec.parser((_, value) => empty = value).push(Buffer.from('7856341200000000', 'hex'));
  assert.equal(empty.length, 0);
});

test('configuration rejects wildcard/public listeners, wildcard targets and unarmed writes', t => {
  const c = config(t);
  for (const override of [{listen: '0.0.0.0'}, {listen: '8.8.8.8'}, {advertiseIp: '8.8.8.8'},
    {listen: '192.168.50.10'}, {mode: 'bind-once'}, {target: {...target, sourceIp: '0.0.0.0'}},
    {target: {...target, did: '*'}}, {mode: 'bind-once', arm: true, target: {...target, uid: ''}}]) {
    assert.throws(() => validateConfig({...c, ...override}));
  }
  assert.equal(validateConfig(c).mode, 'observe');
});

test('HTTP bootstrap matches firmware four-field route and validates identity/encrypted proof', async t => {
  const s = await run(t, config(t));
  const good = await request(s, bootstrapBody());
  assert.equal(good.status, 200);
  assert.equal(good.headers.connection, 'close'); assert.ok(good.headers['content-length']);
  assert.deepEqual(dec(Buffer.from(good.body.secret, 'base64')).toString().split('_'),
    ['127.0.0.1', '127.0.0.1', String(s.addresses.tcp.port), 'local']);
  assert.ok(good.body.token.length < 32);
  for (const body of [bootstrapBody({did: 'OTHER'}), bootstrapBody({code: 'OTHER'}),
    bootstrapBody({secret: enc(Buffer.from('other_proof')).toString('base64')})]) {
    assert.equal((await request(s, body)).status, 403);
  }
  for (const body of ['{}', '[]', '{bad', bootstrapBody({secret: '@bad'})]) {
    assert.notEqual((await request(s, body)).status, 200);
  }
  assert.equal((await request(s, 'x'.repeat(2049))).status, 413);
  assert.equal((await request(s, '{}', {path: '/other'})).status, 404);
  assert.equal((await request(s, '{}', {method: 'GET'})).status, 404);
  const again = await bootstrap(s); assert.equal(again, good.body.token);
});

test('only exact source address reaches HTTP or TCP; no X-Forwarded-For bypass', async t => {
  const s = await run(t, config(t));
  await assert.rejects(request(s, bootstrapBody(), {localAddress: '127.0.0.2', headers: {'X-Forwarded-For': '127.0.0.1'}}));
  const p = await client(t, s, '127.0.0.2'); await p.closed;
  assert.equal(s.status().httpAccepted, 0); assert.equal(s.status().tcpRegistered, 0);
  assert.equal(s.status().deliveryAttempted, false);
});

test('target code can be learned locally once, without APP extraction; wrong device cannot pin or replace it', async t => {
  const c = config(t, {learnCodeFromBootstrap: true, target: {...target, code: undefined}});
  const s = await run(t, c), file = path.join(c.dataDir, 'binding-state.json');
  assert.equal((await request(s, bootstrapBody({did: 'OTHER'}))).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(file)).deviceCode, null);
  const token = await bootstrap(s);
  assert.equal(JSON.parse(fs.readFileSync(file)).deviceCode, target.code);
  const other = bootstrapBody({code: 'other-code', secret: enc(Buffer.from(target.did + '_other-code')).toString('base64')});
  assert.equal((await request(s, other)).status, 403);
  const p = await client(t, s); p.send(1, registration(token)); assert.equal((await p.read()).event, 1);
  await s.close();
  const next = await run(t, c);
  assert.equal((await request(next, other)).status, 403);
  assert.equal(await bootstrap(next), token);
});

test('observe mode supports registration/heartbeat/shadow without sending passwords', async t => {
  const c = config(t), s = await run(t, c), token = await bootstrap(s), p = await client(t, s);
  const bytes = wire(1, registration(token));
  p.socket.write(bytes.subarray(0, 5)); await delay(10); p.socket.write(bytes.subarray(5));
  assert.equal((await p.read()).event, 1);
  p.socket.write(Buffer.concat([wire(8, {area: 0, userid: target.uid}), wire(4, {bootup: 1, version: 7}), wire(0, {status: 'active'})]));
  assert.deepEqual(await p.read(), {event: 4, body: {version: 7}});
  assert.deepEqual(await p.read(), {event: 0, body: {}});
  p.socket.write(Buffer.concat([wire(7, {version: 7}), wire(0, {})]));
  assert.deepEqual(await p.read(), {event: 0, body: {}});
  assert.ok(s.logs.some(x => x.event === 'system_shadow_ack_observed'));
  p.send(3, {code: 'unsolicited'}); await delay(30);
  assert.equal(p.queue.length, 0); assert.equal(s.status().bindingAttempts, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dataDir, 'binding-state.json'))).password, undefined);
  p.send(0x11, {}); await p.closed;
  assert.equal(s.status().rejected, 1);
});

test('incorrect DID, code, firmware, token or UID never registers or writes', async t => {
  const s = await run(t, config(t, {mode: 'bind-once', arm: true})), token = await bootstrap(s);
  for (const extra of [{did: 'OTHER'}, {code: 'OTHER'}, {version: 'other'}, {token: 'other'}, {uid: 'other'}]) {
    const p = await client(t, s); p.send(1, registration(token, extra)); await p.closed;
  }
  assert.equal(s.status().tcpRegistered, 0); assert.equal(s.status().bindingAttempts, 0);
});

test('one-shot binding requires challenge/allow/request and persists before delivery; restart never rotates it', async t => {
  const c = config(t, {mode: 'bind-once', arm: true});
  const s = await run(t, c), token = await bootstrap(s), p = await client(t, s);
  p.send(1, registration(token)); assert.equal((await p.read()).event, 1);
  const add = await p.read(); assert.equal(add.event, 2); assert.equal(add.body.code.length, 6);
  p.socket.write(Buffer.concat([wire(2, {state: 'allow', code: add.body.code}), wire(3, {code: add.body.code})]));
  const binding = await p.read(); assert.equal(binding.event, 3);
  const saved = JSON.parse(fs.readFileSync(path.join(c.dataDir, 'binding-state.json')));
  assert.equal(binding.body.password, saved.password); assert.equal(binding.body.uid, target.uid);
  assert.equal(saved.status, 'delivery-attempted'); assert.equal(saved.cameraAccepted, false);
  p.send(4, {version: 0}); assert.equal((await p.read()).event, 4);
  p.send(3, {code: add.body.code}); await p.closed;
  assert.equal(s.status().bindingAttempts, 1); assert.equal(s.status().cameraAccepted, false);
  const logs = JSON.stringify(s.logs);
  for (const secret of [target.did, target.code, target.uid, token, saved.password, add.body.code]) assert.ok(!logs.includes(secret));
  await s.close();
  const restarted = await run(t, c), newToken = await bootstrap(restarted);
  assert.equal(newToken, token);
  const p2 = await client(t, restarted); p2.send(1, registration(newToken)); assert.equal((await p2.read()).event, 1);
  p2.send(0, {}); assert.equal((await p2.read()).event, 0); assert.equal(p2.queue.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dataDir, 'binding-state.json'))).password, saved.password);
  assert.equal(restarted.status().bindingAttempts, 0);
});

test('out-of-order or wrong challenge cannot cause a credential write', async t => {
  const s = await run(t, config(t, {mode: 'bind-once', arm: true})), token = await bootstrap(s);
  for (const variant of ['no-allow', 'wrong-allow', 'wrong-request']) {
    const p = await client(t, s); p.send(1, registration(token)); await p.read();
    const {code} = (await p.read()).body;
    if (variant === 'wrong-allow') p.send(2, {code: 'wrong', state: 'allow'});
    else {
      if (variant === 'wrong-request') p.send(2, {code, state: 'allow'});
      p.send(3, {code: variant === 'wrong-request' ? 'wrong' : code});
    }
    await p.closed;
  }
  assert.equal(s.status().bindingAttempts, 0); assert.equal(s.status().deliveryAttempted, false);
});

test('optional local P2P bootstrap is explicitly armed, follows binding, and stops once the version is acknowledged', async t => {
  const profile = {did: 'TEST00000000ABCDE', license: 'TESTLICENSE', address: 'DAS-00112233', version: 1};
  const c = config(t, {mode: 'bind-once', arm: true, allowP2pBootstrap: true, p2pBootstrap: profile});
  for (const bad of [{mode:'observe'}, {allowP2pBootstrap:false}, {p2pBootstrap:{...profile, version:256}},
    {p2pBootstrap:{...profile, license:'x'.repeat(12)}}]) assert.throws(()=>validateConfig({...c,...bad}));
  const s = await run(t,c), token = await bootstrap(s), p = await client(t,s);
  p.send(1,registration(token)); await p.read(); const {code}=(await p.read()).body;
  p.send(4,{version:0}); assert.deepEqual(await p.read(),{event:4,body:{version:0}});
  p.send(2,{code,state:'allow'}); p.send(3,{code}); assert.equal((await p.read()).event,3);
  p.send(4,{version:0}); const shadow=await p.read();
  assert.deepEqual(shadow,{event:4,body:{version:1,desired:{p2p:{did:profile.did,license:profile.license,address:profile.address}}}});
  p.send(7,{version:1}); p.send(4,{version:1});
  assert.deepEqual(await p.read(),{event:4,body:{version:1}});
  const logs=JSON.stringify(s.logs);for(const value of [profile.did,profile.license,profile.address])assert.ok(!logs.includes(value));
});

test('malformed frames, invalid JSON and frame flood close the session without writes', async t => {
  const s = await run(t, config(t)), token = await bootstrap(s);
  for (const bytes of [Buffer.alloc(8), Buffer.from('7856341201001020', 'hex'),
    createCodec(key, iv).frame(1, Buffer.from([0xc0, 0xaf])), wire(1, [])]) {
    const p = await client(t, s); p.socket.write(bytes); await p.closed;
  }
  const p = await client(t, s); p.send(1, registration(token)); await p.read();
  p.socket.write(Buffer.concat(Array.from({length: 130}, () => wire(0, {})))); await p.closed;
  assert.equal(s.status().bindingAttempts, 0); assert.equal(s.status().rejected, 5);
});

test('absolute registration/partial-frame deadlines and authenticated idle timeout release sockets', async t => {
  const s = await run(t, config(t, {deadlineMs: 120, sessionMs: 700, idleMs:200})), token = await bootstrap(s);
  const slow = await client(t, s); slow.socket.write(Buffer.from([0x78])); await slow.closed;
  const partial = await client(t, s); partial.send(1, registration(token)); await partial.read();
  partial.socket.write(wire(0, {}).subarray(0, 9)); await partial.closed;
  const live = await client(t, s); live.send(1, registration(token)); await live.read();
  await live.closed;
  assert.equal(s.status().bindingAttempts, 0);
  for(let i=0;i<20&&!s.logs.some(x=>x.event==='target_disconnected'&&x.reason==='idle_timeout');i++)await delay(5);
  assert.ok(s.logs.some(x=>x.event==='target_disconnected'&&x.reason==='idle_timeout'));
});

test('authenticated heartbeats survive the old session deadline while each traffic window remains bounded', async t => {
  const s=await run(t,config(t,{deadlineMs:120,sessionMs:150,idleMs:500})),token=await bootstrap(s);
  const p=await client(t,s);p.send(1,registration(token));await p.read();
  for(let round=0;round<2;round++){
    for(let i=0;i<70;i++){p.send(0,{});assert.equal((await p.read()).event,0);}
    await delay(180);
  }
  p.send(0,{});assert.equal((await p.read()).event,0);
  assert.equal(s.status().tcpRegistered,1);assert.equal(s.status().targetConnected,true);
  p.socket.write(Buffer.concat(Array.from({length:130},()=>wire(0,{}))));await p.closed;
  assert.equal(s.status().rejected,1);assert.equal(s.status().bindingAttempts,0);
});

test('authenticated reconnect replaces a half-open session; unknown clients cannot evict it', async t => {
  const s=await run(t,config(t,{deadlineMs:150})),token=await bootstrap(s);
  const old=await client(t,s);old.send(1,registration(token));await old.read();
  const idle=await client(t,s);await idle.closed;
  old.send(0,{});assert.equal((await old.read()).event,0);
  const bad=await client(t,s);bad.send(1,registration('wrong-token'));await bad.closed;
  old.send(0,{});assert.equal((await old.read()).event,0);
  const replacement=await client(t,s);replacement.send(1,registration(token));
  assert.equal((await replacement.read()).event,1);await old.closed;
  replacement.send(0,{});assert.equal((await replacement.read()).event,0);
  assert.equal(s.status().bindingAttempts,0);
  assert.equal(s.logs.filter(x=>x.event==='authenticated_session_replaced').length,1);
  for(let i=0;i<20&&!s.logs.some(x=>x.reason==='authenticated_replacement');i++)await delay(5);
  assert.ok(s.logs.some(x=>x.event==='target_disconnected'&&x.reason==='authenticated_replacement'));
});

test('authenticated power diagnostics exclude private and malformed fields and rate-limit logs', async t => {
  const s=await run(t,config(t)),token=await bootstrap(s),p=await client(t,s);
  p.send(1,registration(token));await p.read();
  const heartbeat={status:'active',electricity:76,voltage:'4090mv',charging:1,password:'DO-NOT-LOG',token:'PRIVATE-TOKEN',ssid:'PRIVATE-SSID'};
  for(let i=0;i<3;i++){p.send(0,heartbeat);assert.deepEqual((await p.read()).body,{});}
  assert.deepEqual(s.logs.filter(x=>x.event==='target_heartbeat'),[
    {event:'target_heartbeat',status:'active',batteryPercent:76,charging:true,voltageMv:4090}]);
  const saved=s.status().lastHeartbeat;
  assert.ok(Number.isFinite(Date.parse(saved.at)));assert.equal(saved.voltageMv,4090);
  p.send(0,{status:'PRIVATE-STATUS',electricity:'PRIVATE-VALUE',voltage:'4090mv PRIVATE',charging:{private:true}});await p.read();
  assert.deepEqual(s.status().lastHeartbeat,saved);
  assert.doesNotMatch(JSON.stringify([s.logs,s.status()]),/DO-NOT-LOG|PRIVATE/);
  const replacement=await client(t,s);replacement.send(1,registration(token));await replacement.read();
  assert.equal(s.status().lastHeartbeat,null);
});

test('state locks and failed listen cleanup', async t => {
  const c = config(t), s = await run(t, c);
  await assert.rejects(startBindingService(c));
  assert.ok(fs.existsSync(path.join(c.dataDir, process.platform==='linux'?'binding.guard':'binding.lock')));
  const failConfig = config(t, {httpPort: s.addresses.http.port});
  await assert.rejects(startBindingService(failConfig));
  assert.equal(fs.existsSync(path.join(failConfig.dataDir, 'binding.lock')), false);
  const recovered = await run(t, {...failConfig, httpPort: 0});
  assert.ok(recovered.addresses.tcp.port > 0);
  await s.close(); await s.close();
  assert.equal(fs.existsSync(path.join(c.dataDir, 'binding.lock')), false);
});

test('corrupt or mismatched state fails closed instead of replacing existing credentials', async t => {
  const c = config(t), s = await run(t, c); await s.close();
  const file = path.join(c.dataDir, 'binding-state.json'), original = fs.readFileSync(file);
  await assert.rejects(startBindingService({...c, target: {...target, did: 'OTHER'}}));
  assert.deepEqual(fs.readFileSync(file), original);
  fs.writeFileSync(file, '{broken'); await assert.rejects(startBindingService(c));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('disk failure prevents delivery; an ambiguous committed write remains consumed across restart', async t => {
  const c = config(t, {mode: 'bind-once', arm: true}), s = await run(t, c), token = await bootstrap(s);
  const p = await client(t, s); p.send(1, registration(token)); await p.read();
  const {code} = (await p.read()).body;
  const original = fs.renameSync, stateFile = path.join(c.dataDir, 'binding-state.json');
  try {
    fs.renameSync = (from, to) => {
      original(from, to);
      if (to === stateFile) throw new Error('synthetic_durability_failure');
    };
    p.socket.write(Buffer.concat([wire(2, {code, state: 'allow'}), wire(3, {code})]));
    await p.closed;
  } finally { fs.renameSync = original; }
  assert.equal(p.queue.length, 0); assert.equal(s.status().bindingAttempts, 0);
  const saved = JSON.parse(fs.readFileSync(stateFile)); assert.equal(saved.status, 'delivery-attempted');
  await s.close();
  const next = await run(t, c); assert.equal(next.status().deliveryAttempted, true);
});

test('HTTP slow header cannot extend its absolute deadline by sending bytes', async t => {
  const s = await run(t, config(t, {deadlineMs: 150}));
  const socket = net.connect(s.addresses.http.port, '127.0.0.1'); socket.on('error', () => {});
  t.after(() => socket.destroy());
  const closed = new Promise(resolve => socket.on('close', resolve)); await once(socket, 'connect');
  socket.write('POST /node/query HTTP/1.1\r\nX-Slow: ');
  const drip = setInterval(() => socket.write('x'), 30);
  try { await closed; } finally { clearInterval(drip); }
  assert.equal(s.status().httpAccepted, 0);
});

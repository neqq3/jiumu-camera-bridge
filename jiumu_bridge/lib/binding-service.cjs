// SPDX-License-Identifier: Apache-2.0
'use strict';
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {createCodec, parseObject, same} = require('./binding-codec.cjs');
const {openState} = require('./binding-state.cjs');

function localIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function validateConfig(input) {
  const c = {...input, target: {...input.target}, mode: input.mode ?? 'observe',
    listen: input.listen ?? '127.0.0.1', httpPort: input.httpPort ?? 18084, tcpPort: input.tcpPort ?? 18085,
    deadlineMs: input.deadlineMs ?? 15000, sessionMs: input.sessionMs ?? 300000,
    idleMs: input.idleMs ?? 90000};
  const atom = (v, n) => typeof v === 'string' && v.length >= 1 && v.length <= n && /^[A-Za-z0-9.-]+$/.test(v);
  // A separate mode avoids coupling privacy configuration to password/identity
  // provisioning. Firmware 21.120.101.42 ignores the similarly named CGI setter.
  if (c.mode === 'configure-alarm-upload') {
    const p = c.alarmUpload;
    if (c.arm !== true || c.target.firmware !== '21.120.101.42' || !atom(c.target.uid, 31) ||
        !p || typeof p !== 'object' || Array.isArray(p) ||
        Object.keys(p).some(k => !['enabled', 'version'].includes(k)) ||
        typeof p.enabled !== 'boolean' || !Number.isInteger(p.version) || p.version < 1 || p.version > 0x7fffffff ||
        c.allowP2pBootstrap === true || c.p2pBootstrap !== undefined) throw new Error('invalid_alarm_upload_policy');
    c.alarmUpload = Object.freeze({enabled: p.enabled, version: p.version});
  } else if (c.alarmUpload !== undefined) throw new Error('invalid_alarm_upload_policy');
  // Address-only shadow update for an already owned camera. Deliberately cannot
  // set DID, license, owner, password, detection or recording fields.
  if (c.mode === 'configure-p2p-endpoint') {
    const p=c.p2pEndpoint;
    if(c.arm!==true || c.target.firmware!=='21.120.101.42' || !atom(c.target.uid,31) ||
       !p || typeof p!=='object' || Array.isArray(p) ||
       Object.keys(p).some(k=>!['address','version'].includes(k)) ||
       typeof p.address!=='string' || !/^DAS-(?:[a-f0-9]{32})+$/i.test(p.address) || p.address.length>254 ||
       !Number.isInteger(p.version) || p.version<1 || p.version>0x7fffffff ||
       c.allowP2pBootstrap===true || c.p2pBootstrap!==undefined) throw new Error('invalid_p2p_endpoint_policy');
    c.p2pEndpoint=Object.freeze({address:p.address,version:p.version});
  } else if(c.p2pEndpoint!==undefined) throw new Error('invalid_p2p_endpoint_policy');
  if (c.p2pBootstrap !== undefined && (c.mode !== 'bind-once' || c.arm !== true || c.allowP2pBootstrap !== true ||
      !atom(c.p2pBootstrap.did, 23) || !atom(c.p2pBootstrap.license, 11) ||
      typeof c.p2pBootstrap.address !== 'string' || !/^DAS-[a-f0-9]+$/i.test(c.p2pBootstrap.address) || c.p2pBootstrap.address.length > 254 ||
      !Number.isInteger(c.p2pBootstrap.version) || c.p2pBootstrap.version < 1 || c.p2pBootstrap.version > 255)) throw new Error('invalid_p2p_bootstrap');
  if (!['observe', 'bind-once', 'configure-alarm-upload', 'configure-p2p-endpoint'].includes(c.mode) || !localIPv4(c.listen) ||
      !localIPv4(c.advertiseIp) || !localIPv4(c.target.sourceIp) ||
      !atom(c.target.did, 23) || !(atom(c.target.code, 23) || (c.target.code === undefined && c.learnCodeFromBootstrap === true)) ||
      !atom(c.target.firmware, 31) || typeof c.dataDir !== 'string' || !c.dataDir ||
      ![c.httpPort, c.tcpPort].every(p => Number.isInteger(p) && p >= 0 && p <= 65535) ||
      (c.httpPort !== 0 && c.httpPort === c.tcpPort) ||
      ![c.deadlineMs, c.sessionMs, c.idleMs].every(n => Number.isInteger(n) && n >= 100 && n <= 300000) ||
      (c.listen !== '127.0.0.1' && c.allowLan !== true) ||
      (c.mode === 'bind-once' && (!atom(c.target.uid, 31) || c.arm !== true))) {
    throw new Error('invalid_configuration');
  }
  return c;
}

async function startBindingService(input, log = () => {}) {
  const c = validateConfig(input);
  const codec = createCodec(c.key, c.iv);
  const store = openState(c.dataDir, {did: c.target.did, code: c.target.code, firmware: c.target.firmware, uid: c.target.uid ?? ''});
  const sockets = new Set();
  const stats = {httpAccepted: 0, tcpRegistered: 0, rejected: 0, bindingAttempts: 0, shadowSeen: 0};
  let tcpPort, activeSession = null, stopping = false, lastHeartbeat = null;
  let alarmUploadState = c.alarmUpload ? 'awaiting_shadow' : null;
  let alarmUploadDeliveries = 0, alarmUploadAcks = 0, lastShadowVersion = null;
  let endpointState=c.p2pEndpoint?'awaiting_shadow':null,endpointDeliveries=0,endpointAcks=0;
  const disconnect = new WeakMap();
  // Only fixed names and protocol event numbers leave this service, never payloads or identifiers.
  const note = (event, details = {}) => { try { log({event, ...details}); } catch {} };
  const reject = (socket, reason = 'invalid_request') => { stats.rejected++; note('request_rejected', {reason}); socket.destroy(); };
  function accept(socket) {
    socket.on('error', () => {});
    if (stopping || socket.remoteAddress !== c.target.sourceIp || sockets.size >= 4) {
      reject(socket, socket.remoteAddress !== c.target.sourceIp ? 'source_not_allowed' : 'connection_limit'); return false;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return true;
  }
  const tcp = net.createServer(socket => {
    if (!accept(socket)) return;
    let registered = false, challenge = null, allowed = false, sent = false, frames = 0, bytes = 0;
    let alarmUploadSent = false, alarmUploadAcked = false;
    let endpointSent=false,endpointAcked=false;
    let budgetAt = performance.now();
    const connectedAt=performance.now();let receivedAt=connectedAt,closeReason='peer_closed';
    const end=reason=>{closeReason=reason;socket.destroy();};
    disconnect.set(socket,end);
    let heartbeatLogAt=-Infinity;
    const absolute = setTimeout(() => end('unregistered_session_deadline'), c.sessionMs);
    let phaseTimer = setTimeout(() => end('registration_deadline'), c.deadlineMs);
    let partialTimer;
    socket.setNoDelay(true);
    socket.setTimeout(c.idleMs, () => end('idle_timeout'));
    socket.on('end',()=>{if(closeReason==='peer_closed')closeReason='peer_end';});
    socket.on('error',()=>{if(closeReason==='peer_closed')closeReason='peer_error';});
    socket.on('close', () => {
      if (activeSession === socket) activeSession = null;
      clearTimeout(absolute); clearTimeout(phaseTimer); clearTimeout(partialTimer);
      if(registered)note('target_disconnected',{reason:stopping?'service_stop':closeReason,
        sessionMs:Math.round(performance.now()-connectedAt),receivedAgoMs:Math.round(performance.now()-receivedAt)});
    });
    const send = (event, body) => {
      if (socket.destroyed || socket.writableLength > 16384) throw new Error('slow_peer');
      socket.write(codec.frame(event, body));
    };
    const parser = codec.parser((event, plain) => {
      if (socket.destroyed || ++frames > 128) throw new Error('frame_limit');
      const body = parseObject(plain);
      if (!registered) {
        if (event !== 1) throw new Error('registration_required');
        if (!same(body.did, c.target.did) || !same(body.code, store.deviceCode) ||
            !same(body.version, c.target.firmware) || !same(body.token, store.token) ||
            (c.mode !== 'observe' && !same(body.uid, c.target.uid))) throw new Error('identity_mismatch');
        // A reboot may leave the old TCP connection half-open. Only a fully
        // authenticated replacement can evict it; an unauthenticated socket
        // is bounded by the registration deadline and the TCP connection cap.
        if (activeSession && activeSession !== socket) {
          disconnect.get(activeSession)('authenticated_replacement'); note('authenticated_session_replaced');
        }
        activeSession = socket;
        lastHeartbeat = null;
        lastShadowVersion = null;
        if (c.alarmUpload) alarmUploadState = 'awaiting_shadow';
        if (c.p2pEndpoint) endpointState='awaiting_shadow';
        registered = true; stats.tcpRegistered++;
        note('target_registered', Number.isInteger(body.onlineReason)&&body.onlineReason>=0&&body.onlineReason<=255
          ? {onlineReason:body.onlineReason} : {});
        note(same(body.uid, c.target.uid) ? 'target_owner_matches' : 'target_owner_differs');
        // A healthy authenticated camera needs a persistent control connection.
        // Retain idle/partial/challenge deadlines and per-window traffic bounds,
        // instead of forcing a cloud-style reconnect every five minutes.
        clearTimeout(absolute); clearTimeout(phaseTimer);
        send(1, {timestamp: Math.floor(Date.now() / 1000)});
        if (c.mode === 'bind-once' && !store.attempted) {
          challenge = crypto.randomBytes(3).toString('hex');
          phaseTimer = setTimeout(() => end('challenge_deadline'), c.deadlineMs);
          send(2, {code: challenge});
        }
        return;
      }
      if (event === 0) {
        // Firmware heartbeat 0x3f4f4 exposes power state. Never log arbitrary
        // payload fields: the registration carries identifiers and credentials.
        const power={};
        if(body.status==='active'||body.status==='sleep')power.status=body.status;
        if(Number.isInteger(body.electricity)&&body.electricity>=0&&body.electricity<=100)power.batteryPercent=body.electricity;
        if(body.charging===0||body.charging===1)power.charging=body.charging===1;
        if(typeof body.voltage==='string'&&/^[1-6][0-9]{3}mv$/.test(body.voltage))power.voltageMv=Number(body.voltage.slice(0,-2));
        if(Object.keys(power).length) {
          lastHeartbeat={at:new Date().toISOString(),...power};
          if(performance.now()-heartbeatLogAt>=15000){note('target_heartbeat',power);heartbeatLogAt=performance.now();}
        }
        send(0, {}); return;
      }
      // A cached endpoint with an old token will be rejected; use fresh bootstrap, never bypass identity checks.
      if (event === 8) { note('hello_observed'); return; }
      if (event === 4) {
        // Echo existing settings by default. The explicit, firmware-specific lab profile
        // may initialize P2P after binding; never send unrelated desired settings.
        if (!Number.isInteger(body.version) || body.version < 0 || body.version > 0x7fffffff) throw new Error('invalid_shadow');
        lastShadowVersion = body.version;
        stats.shadowSeen++; note(sent ? 'post_delivery_shadow_observed' : 'shadow_observed');
        if(c.p2pEndpoint) {
          const {address,version}=c.p2pEndpoint;
          if(body.version<version && !endpointSent) {
            send(4,{version,desired:{p2p:{address}}});
            endpointSent=true;endpointDeliveries++;endpointState='sent_unverified';
            note('p2p_endpoint_policy_sent',{version});
          } else {
            send(4,{version:body.version});
            if(body.version>version || !endpointSent) endpointState=body.version===version?'version_matches_unverified':'newer_version_unverified';
          }
          return;
        }
        if (c.alarmUpload) {
          const {enabled, version} = c.alarmUpload;
          if (body.version < version && !alarmUploadSent) {
            // Never include alarm.motion_enabled, p2p, work_mode, credentials,
            // or recording settings: these have separate firmware side effects.
            send(4, {version, desired: {isReport: enabled ? 1 : 0}});
            alarmUploadSent = true; alarmUploadDeliveries++; alarmUploadState = 'sent_unverified';
            note('alarm_upload_policy_sent', {enabled, version});
          } else {
            send(4, {version: body.version});
            if (body.version > version || !alarmUploadSent) {
              alarmUploadState = body.version === version ? 'version_matches_unverified' : 'newer_version_unverified';
              note('alarm_upload_policy_not_sent', {reason: alarmUploadState});
            }
          }
          return;
        }
        if (c.p2pBootstrap && store.attempted && body.version < c.p2pBootstrap.version) {
          const {did, license, address, version} = c.p2pBootstrap;
          send(4, {version, desired: {p2p: {did, license, address}}});
          note('local_p2p_bootstrap_sent');
        } else send(4, {version: body.version});
        return;
      }
      if (event === 5) { note('shadow_ack_observed'); return; }
      // Firmware 0x3fc14 acknowledges the system shadow using event 7.
      if (event === 7) {
        if (!Number.isInteger(body.version) || body.version < 0 || body.version > 0x7fffffff) throw new Error('invalid_shadow_ack');
        if(c.p2pEndpoint && endpointSent && !endpointAcked && body.version===c.p2pEndpoint.version && lastShadowVersion<=c.p2pEndpoint.version) {
          endpointAcked=true;endpointAcks++;endpointState='acknowledged_unverified';
          note('p2p_endpoint_policy_ack_observed',{version:body.version});
        }
        if (c.alarmUpload && alarmUploadSent && !alarmUploadAcked && body.version === c.alarmUpload.version &&
            lastShadowVersion <= c.alarmUpload.version) {
          alarmUploadAcked = true; alarmUploadAcks++; alarmUploadState = 'acknowledged_unverified';
          note('alarm_upload_policy_ack_observed', {version: body.version});
        }
        note('system_shadow_ack_observed'); return;
      }
      if (event === 2 && challenge && !sent && !allowed && same(body.code, challenge) && body.state === 'allow') {
        allowed = true; note('binding_challenge_allowed'); return;
      }
      if (event === 3 && challenge && !sent && allowed && same(body.code, challenge)) {
        const password = store.prepareDelivery(c.target.uid);
        sent = true; stats.bindingAttempts++; clearTimeout(phaseTimer);
        send(3, {code: challenge, uid: c.target.uid, password});
        note('binding_delivery_attempted'); return;
      }
      // In observation mode add/bind requests never trigger a password response.
      if (c.mode === 'observe' && (event === 2 || event === 3)) { note('binding_request_observed'); return; }
      note('unsupported_event', {number: event});
      throw new Error('unexpected_event');
    });
    socket.on('data', chunk => {
      try {
        receivedAt=performance.now();
        if (registered && performance.now() - budgetAt >= c.sessionMs) {
          budgetAt = performance.now(); frames = 0; bytes = 0;
        }
        bytes += chunk.length;
        if (bytes > 131072) throw new Error('session_limit');
        parser.push(chunk);
        if (!parser.pending) { clearTimeout(partialTimer); partialTimer = undefined; }
        else if (!partialTimer) partialTimer = setTimeout(() => end('partial_frame_deadline'), c.deadlineMs);
      } catch (error) {
        // Use a closed vocabulary: parser and filesystem errors can contain private data.
        const reasons = ['registration_required', 'identity_mismatch', 'frame_limit', 'session_limit',
          'slow_peer', 'invalid_shadow', 'invalid_shadow_ack', 'unexpected_event'];
        closeReason='request_rejected';
        reject(socket, reasons.includes(error.message) ? error.message : 'malformed_or_state_failure');
      }
    });
  });
  const server = http.createServer({maxHeaderSize: 4096}, (req, res) => {
    if (!sockets.has(req.socket)) { req.socket.destroy(); return; }
    res.shouldKeepAlive = false;
    let size = 0, chunks = [], done = false;
    const timer = setTimeout(() => req.destroy(), c.deadlineMs);
    const finish = (code, body) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(code, {'Content-Type': 'application/json', 'Content-Length': data.length, 'Connection': 'close', 'Cache-Control': 'no-store'});
      res.end(data);
    };
    const deny = code => { stats.rejected++; note('request_rejected'); finish(code, {error: 'request_rejected'}); };
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => {});
    if (req.method !== 'POST' || req.url !== '/node/query') { deny(404); return; }
    if (req.headers['transfer-encoding'] || !/^(0|[1-9][0-9]*)$/.test(req.headers['content-length'] ?? '') ||
        Number(req.headers['content-length']) > 2048) { deny(413); return; }
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2048) { deny(413); req.destroy(); } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const body = parseObject(Buffer.concat(chunks)); chunks = [];
        if (!same(body.did, c.target.did) || typeof body.code !== 'string' || !/^[A-Za-z0-9.-]{1,23}$/.test(body.code) ||
            !same(codec.fromBase64(body.secret).toString('utf8'), c.target.did + '_' + body.code) ||
            !store.pinDeviceCode(body.code)) {
          deny(403); return;
        }
        // Firmware 0x42aa0 requires four nonempty underscore-delimited fields.
        // It uses IP/domain/port and only checks presence of the fourth; it never consumes its value.
        const route = `${c.advertiseIp}_${c.advertiseIp}_${tcpPort}_local`;
        stats.httpAccepted++; note('target_bootstrap_accepted');
        finish(200, {token: store.token, secret: codec.encrypt(Buffer.from(route)).toString('base64')});
      } catch { deny(400); }
    });
  });
  server.on('connection', socket => {
    if (!accept(socket)) return;
    const absolute = setTimeout(() => socket.destroy(), c.deadlineMs);
    socket.on('close', () => clearTimeout(absolute));
    socket.setTimeout(c.deadlineMs, () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => reject(socket));
  server.on('checkContinue', (req, res) => { res.writeHead(417, {'Connection': 'close'}); res.end(); });
  server.requestTimeout = c.deadlineMs;
  server.headersTimeout = c.deadlineMs;
  server.maxRequestsPerSocket = 1;
  tcp.maxConnections = 2; server.maxConnections = 4;
  async function listen(s, port) {
    await new Promise((resolve, rejectPromise) => {
      const onError = e => { s.removeListener('listening', onListen); rejectPromise(e); };
      const onListen = () => { s.removeListener('error', onError); resolve(); };
      s.once('error', onError); s.once('listening', onListen); s.listen(port, c.listen);
    });
  }
  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([tcp, server].map(s => s.listening ? new Promise(resolve => s.close(resolve)) : undefined));
      store.close();
    })();
    return closePromise;
  }
  try {
    await listen(tcp, c.tcpPort); tcpPort = tcp.address().port;
    await listen(server, c.httpPort);
    tcp.on('error', () => { note('listener_failed'); void close(); });
    server.on('error', () => { note('listener_failed'); void close(); });
    note('service_started');
  } catch (error) { await close(); throw error; }
  return {addresses: {http: server.address(), tcp: tcp.address()}, close,
    status: () => ({...stats, listening:tcp.listening&&server.listening, targetConnected:!!activeSession&&!activeSession.destroyed,
      lastHeartbeat:lastHeartbeat?{...lastHeartbeat}:null,
      lastShadowVersion,
      p2pEndpointPolicy:c.p2pEndpoint?{version:c.p2pEndpoint.version,state:endpointState,deliveries:endpointDeliveries,acknowledgements:endpointAcks,deviceStateVerified:false}:null,
      alarmUploadPolicy: c.alarmUpload ? {...c.alarmUpload, state: alarmUploadState,
        deliveries: alarmUploadDeliveries, acknowledgements: alarmUploadAcks, deviceStateVerified: false} : null,
      mode: c.mode, deliveryAttempted: store.attempted, cameraAccepted: false, videoVerified: false})};
}
module.exports = {startBindingService, validateConfig};

'use strict';
const crypto=require('node:crypto');
const md5=(...parts)=>crypto.createHash('md5').update(Buffer.concat(parts.map(x=>Buffer.isBuffer(x)?x:Buffer.from(x)))).digest();
const initial=md5(Buffer.alloc(61)).toString('hex').toUpperCase();
const second=md5(...[3,14,17,20,24].map(n=>initial.slice(0,n))).toString('hex').toUpperCase();
const IV=Buffer.from(second.slice(0,16));
function aes(data,key,decrypt=false) {
  if(data.length%16)throw new Error('Invalid AES block length');
  const cipher=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)('aes-128-cbc',key,IV);
  cipher.setAutoPadding(false);return Buffer.concat([cipher.update(data),cipher.final()]);
}
function network(server) {
  if(!/^DAS-[0-9a-f]+(?::[^\r\n]*)?$/i.test(server))throw new Error('Unsupported HLP2P server metadata');
  const [hex,salt='']=server.slice(4).split(':');
  const plaintext=aes(Buffer.from(hex,'hex'),Buffer.from(initial.slice(0,16)),true).toString().replace(/\0.*$/s,'');
  const fields=plaintext.split(',');
  if(fields[0]!==second.slice(24,32) || fields[1]!=='das' || !/^\d{8}$/.test(fields[2]))throw new Error('Invalid HLP2P metadata');
  return {group:Number(fields[2]),key:md5(fields[2],second.slice(16,24),salt.length>1?salt.slice(0,16):''),iv:IV};
}
function identity(did) {
  const m=/^([A-Z]{4})(\d{8})([A-Z]{5})$/.exec(did.replaceAll('-',''));
  if(!m)throw new Error('Unsupported HLP2P device ID');
  return {prefix:Buffer.from(m[1]),serial:Number(m[2])};
}
function sessionKey(networkKey,nonce) {return md5(String(nonce),networkKey,second.slice(24,32));}
module.exports={aes,network,identity,sessionKey};

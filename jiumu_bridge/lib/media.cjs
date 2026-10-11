'use strict';
const MAGIC=Buffer.from([0x55,0xaa,0x15,0xa8]),MAX=2*1024*1024;
class MediaParser {
  constructor(callback){this.callback=callback;this.buffer=Buffer.alloc(0);}
  reset(){this.buffer=Buffer.alloc(0);}
  accept(chunk) {
    if(this.buffer.length+chunk.length>MAX+65536)this.reset();
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=32) {
      const start=this.buffer.indexOf(MAGIC);
      if(start<0){this.buffer=this.buffer.subarray(-3);return;}
      if(start)this.buffer=this.buffer.subarray(start);
      if(this.buffer.length<32)return;
      const length=this.buffer.readUInt32LE(16),type=this.buffer[4];
      if(length>MAX || length===0 || ![3,7].includes(type)){this.buffer=this.buffer.subarray(4);continue;}
      if(this.buffer.length<32+length)return;
      const body=this.buffer.subarray(32,32+length);this.buffer=this.buffer.subarray(32+length);
      this.callback(type,body);
    }
  }
}
function alawToPcm(input) {
  const out=Buffer.alloc(input.length*2);
  for(let i=0;i<input.length;i++) {
    const a=input[i]^0x55,segment=(a&0x70)>>4;let value=(a&15)<<4;
    value+=segment===0?8:0x108;if(segment>1)value<<=segment-1;
    out.writeInt16LE((a&128)?value:-value,i*2);
  }
  return out;
}
module.exports={MediaParser,alawToPcm};

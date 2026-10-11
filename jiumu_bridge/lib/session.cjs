'use strict';
const {HlpClient}=require('./hlp-client.cjs');
const {MediaParser,alawToPcm}=require('./media.cjs');
class CameraSession {
  constructor(camera) {
    this.camera=camera;this.videoClients=new Set();this.audioClients=new Set();
    this.frames=0;this.audioFrames=0;this.reconnects=0;this.lastVideo=0;this.lastAudio=0;
    this.state='connecting';this.running=true;this.connect();
  }
  connect() {
    if(!this.running)return;
    this.state='connecting';this.started=Date.now();this.lastVideo=0;this.lastAudio=0;this.jpeg=null;
    this.sessionStartFrames=this.frames;
    const parser=new MediaParser((type,body)=>{
      if(type===3) {
        if(body.length<4 || body.readUInt16BE(0)!==0xffd8)return;
        // This firmware appends a short trailer after JPEG EOI (five bytes in
        // captured frames). Pass only the complete JPEG to HTTP consumers.
        const end=body.lastIndexOf(Buffer.from([0xff,0xd9]));
        if(end<2 || body.length-end>64)return;body=body.subarray(0,end+2);
        this.frames++;this.lastVideo=Date.now();this.jpeg=Buffer.from(body);this.state='streaming';
        const header=Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`);
        this.broadcast(this.videoClients,Buffer.concat([header,body,Buffer.from('\r\n')]));
      } else if(type===7) {
        this.audioFrames++;this.lastAudio=Date.now();this.broadcast(this.audioClients,alawToPcm(body));
      }
    });
    this.client=new HlpClient(this.camera.config,{ipHint:this.camera.ipHint||undefined});
    this.client.on('connected',peer=>{this.address=peer.address;this.state='authenticating';});
    this.client.on('data',(channel,data)=>{if(channel===1)parser.accept(data);});
    this.client.on('gap',channel=>{if(channel===1)parser.reset();});
    this.client.on('failure',message=>{
      this.error=message;
      this.lastFailure={at:new Date().toISOString(),reason:message,session_ms:Date.now()-this.started,
        video_frames:this.frames-this.sessionStartFrames,protocol:{...this.client.stats},control:this.client.controlStatus()};
    });
    this.client.on('closed',()=>{
      clearInterval(this.watchdog);this.state='reconnecting';this.jpeg=null;
      for(const res of [...this.videoClients,...this.audioClients])res.destroy();
      if(this.running){this.reconnects++;this.retry=setTimeout(()=>this.connect(),3000);}
    });
    this.client.start();
    this.watchdog=setInterval(()=>{
      if(Date.now()-(this.lastVideo||this.started)>25000)this.client.fail('No fresh video; retrying local connection');
    },1000);
  }
  broadcast(clients,body) {
    for(const res of clients) {
      if(res.destroyed || res.writableLength>512*1024){res.destroy();clients.delete(res);continue;}
      res.write(body);
    }
  }
  status() {
    const now=Date.now();return {id:this.camera.id,name:this.camera.name,state:this.state,
      fresh:!!this.lastVideo&&now-this.lastVideo<3000,audio_fresh:!!this.lastAudio&&now-this.lastAudio<3000,
      frames:this.frames,audio_frames:this.audioFrames,reconnects:this.reconnects,address:this.address||null,
      last_frame_age_ms:this.lastVideo?now-this.lastVideo:null,last_failure:this.lastFailure||null,protocol:this.client.stats};
  }
  serve(res,kind) {
    const s=this.status();if(!s.fresh || kind==='audio.wav'&&!s.audio_fresh){res.writeHead(503);res.end('Camera reconnecting');return;}
    if(kind==='snapshot.jpg'){res.writeHead(200,{'content-type':'image/jpeg','cache-control':'no-store'});res.end(this.jpeg);return;}
    const clients=kind==='audio.wav'?this.audioClients:this.videoClients;
    if(clients.size>=8){res.writeHead(429);res.end('Too many media clients');return;}
    res.writeHead(200,{'content-type':kind==='audio.wav'?'audio/wav':'multipart/x-mixed-replace; boundary=frame','cache-control':'no-store'});
    if(kind==='audio.wav') {
      const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(0xffffffff,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
      b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);
      b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(0xffffffff,40);res.write(b);
    }
    clients.add(res);res.on('close',()=>clients.delete(res));
  }
  stop(){this.running=false;clearTimeout(this.retry);clearInterval(this.watchdog);this.client.close();}
}
module.exports={CameraSession};

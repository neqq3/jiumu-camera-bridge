"""Loopback-only RTSP test. Uses synthetic images, never camera material."""
import json, pathlib, socket, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
server = subprocess.Popen([str(root/'host-server'),str(root/'test.jpg')], stdout=(root/'server.log').open('w'), stderr=subprocess.STDOUT)
def connect():
    s=socket.create_connection(('127.0.0.1',18554),timeout=3)
    s.settimeout(3)
    return s
def exchange(request):
    with connect() as s:
        s.sendall(request)
        return s.recv(4096)
try:
    for _ in range(100):
        if server.poll() is not None: raise RuntimeError('server failed: '+(root/'server.log').read_text())
        try:
            with connect(): pass
            break
        except OSError: time.sleep(.1)
    else: raise RuntimeError('server did not listen')
    assert b'200 OK' in exchange(b'OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n')
    assert b'400 Bad' in exchange(b'OPTIONS * RTSP/1.0\r\nCSeq: 1\r\nCSeq: 2\r\n\r\n')
    assert b'461 Unsupported' in exchange(b'SETUP rtsp://127.0.0.1:18554/live/track0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP;unicast;client_port=5000-5001\r\n\r\n')
    assert b'454 Session' in exchange(b'PLAY rtsp://127.0.0.1:18554/live RTSP/1.0\r\nCSeq: 1\r\nSession: bad\r\n\r\n')
    with connect() as s:
        for chunk in [b'OPT', b'IONS * RTSP/1.0\r\nCSeq: 9\r\n', b'\r\n']:
            s.sendall(chunk)
        assert b'200 OK' in s.recv(4096)
    with connect() as s:
        s.sendall(b'X'*2047)
        assert s.recv(10)==b''
    results=[]
    for i in range(2):
        dest=root/f'decoded-{i}.framemd5'
        command=['ffmpeg','-hide_banner','-loglevel','warning','-rtsp_transport','tcp','-i',
                 'rtsp://127.0.0.1:18554/live','-frames:v','12','-an','-f','framemd5','-y',str(dest)]
        run=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=25)
        (root/f'ffmpeg-{i}.log').write_bytes(run.stdout)
        assert run.returncode==0, run.stdout.decode(errors='replace')
        frames=[line for line in dest.read_text().splitlines() if line and not line.startswith('#')]
        assert len(frames)==12
        results.append({'session':i,'decoded_frames':len(frames),'exit':run.returncode})
    assert server.poll() is None
    (root/'integration.json').write_text(json.dumps({'source':'synthetic testsrc2','transport':'RTSP TCP / RTP JPEG','resolution':'640x480','sessions':results,'camera_contacted':False},indent=2))
    print('Two independent FFmpeg sessions decoded 12 VGA frames each; malformed requests rejected.')
finally:
    server.terminate()
    try: server.wait(timeout=3)
    except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=3)
    if server.returncode not in (0,-15): raise RuntimeError('server exit '+str(server.returncode))

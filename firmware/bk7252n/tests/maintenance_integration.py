"""Exercise the real maintenance HTTP/core against synthetic file-backed flash.

No hardware, stock images, cloud service, household identity or persistent token.
"""
import hashlib
import http.client
import json
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time

from test_ota import package

OUT = pathlib.Path(sys.argv[1]).resolve()
PORT = 18094
BASE = 4096
STAGING = 16384


def main():
    checks = []
    with tempfile.TemporaryDirectory(prefix='synthetic-maintenance-') as folder:
        folder = pathlib.Path(folder)
        token = secrets.token_hex(32)
        (folder/'token').write_text(token, encoding='ascii')
        image = package()
        digest = hashlib.sha256(image).hexdigest()
        (folder/'fixture.rbl').write_bytes(image)
        flash = folder/'flash'
        log = (OUT/'maintenance-http.log').open('w')
        server = None

        def start(mode='verified'):
            nonlocal server
            server = subprocess.Popen([str(OUT/'maintenance-host'), str(folder/'fixture.rbl'),
                                       str(folder/'token'), str(flash), str(PORT), mode],
                                      stdout=log, stderr=subprocess.STDOUT)
            for _ in range(60):
                if server.poll() is not None:
                    raise RuntimeError('maintenance server exited')
                try:
                    with socket.create_connection(('127.0.0.1', PORT), timeout=.1):
                        return
                except OSError:
                    time.sleep(.05)
            raise TimeoutError('maintenance listener')

        def stop():
            nonlocal server
            if server is None:
                return
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=3)
            assert server.returncode in (0, -15), server.returncode
            server = None

        def call(method, path, body=None, kind=None, auth=token):
            headers = {'Authorization': 'Bearer '+auth}
            if kind:
                headers['Content-Type'] = kind
            c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=8)
            try:
                c.request(method, path, body=body, headers=headers)
                r = c.getresponse()
                data = r.read()
                return r.status, data
            finally:
                c.close()

        def raw(data, delay=False):
            with socket.create_connection(('127.0.0.1', PORT), timeout=8) as s:
                s.sendall(data)
                begin = time.monotonic()
                response = b''
                while True:
                    part = s.recv(4096)
                    if not part:
                        break
                    response += part
                if delay:
                    assert 2.0 < time.monotonic()-begin < 5.0
                return response

        def status():
            code, body = call('GET', '/v1/status')
            assert code == 200
            return json.loads(body)

        def stage(data=image):
            return call('POST', '/v1/restore', data, 'application/octet-stream')

        def cli(*args, expected=0):
            run = subprocess.run([sys.executable, str(pathlib.Path(__file__).parents[1]/'maintenance_client.py'),
                                  '--host', '127.0.0.1', '--port', str(PORT), '--token-file',
                                  str(folder/'token'), *map(str, args)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            assert run.returncode == expected, run.stderr.decode(errors='replace')
            return json.loads(run.stdout) if run.stdout else None

        def abort():
            assert call('POST', '/v1/restore/abort', b'')[0] == 200

        try:
            start('disabled')
            before = flash.read_bytes()
            assert stage()[0] == 503
            assert flash.read_bytes() == before
            assert status()['boot_contract_verified'] is False
            checks.append('unknown boot contract refuses upload without changing flash')
            stop()
            start()
            assert call('GET', '/v1/status', auth='0'*64)[0] == 401
            assert call('GET', '/v1/backup', auth='0'*64)[0] == 401
            assert call('POST', '/v1/restore', image, 'application/octet-stream', auth='0'*64)[0] == 401
            assert flash.read_bytes() == before
            checks.append('unauthorized status/backup/restore reveal no data and perform no writes')
            common = f'Host: localhost\r\nAuthorization: Bearer {token}\r\n'.encode()
            for headers in [b'Content-Length: 0\r\nContent-Length: 0\r\n',
                            b'Transfer-Encoding: chunked\r\n', b'Origin: https://example.test\r\n',
                            b'Content-Length: -1\r\n', b'Content-Length: 99999999999999\r\n',
                            b'Authorization: Bearer bad\r\n', b'X-Nul: a\x00b\r\n']:
                assert b'400' in raw(b'POST /v1/restore HTTP/1.1\r\n'+common+headers+b'\r\n')
            assert call('GET', '/v1/reboot')[0] == 404
            assert call('POST', '/v1/reboot', b'')[0] == 409
            assert flash.read_bytes() == before
            checks.append('ambiguous framing, browser origin, header NUL and premature reboot rejected')
            assert raw(b'GET /v1/status HTTP/1.1\r\n', delay=True) == b''
            checks.append('partial headers have fixed deadline')
            # Invalid metadata rejected before erase.
            broken = b'BAD!'+image[4:]
            assert stage(broken)[0] == 409
            assert flash.read_bytes() == before
            abort()
            # Truncated body leaves no boot-consumable header and disconnect
            # releases the single listener for subsequent status/auth requests.
            with socket.create_connection(('127.0.0.1', PORT), timeout=3) as s:
                s.sendall(b'POST /v1/restore HTTP/1.1\r\n'+common+
                          f'Content-Length: {len(image)}\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+image[:300])
                time.sleep(.1)
            for _ in range(30):
                if status()['state'] != 'receiving':
                    break
                time.sleep(.05)
            assert flash.read_bytes()[BASE:BASE+96] == b'\xff'*96
            assert call('POST', '/v1/restore/commit', digest.encode(), 'text/plain')[0] == 409
            checks.append('truncated authenticated upload cannot be committed')
            # A package that passes CRC but is not the pinned whole-image SHA.
            wrong = package(raw=2048)
            assert stage(wrong)[0] == 409
            assert flash.read_bytes()[BASE:BASE+96] == b'\xff'*96
            abort()
            checks.append('CRC-valid untrusted image rejected by independent whole-image hash')
            assert stage()[0] == 200
            assert status()['state'] == 'verified'
            snap = flash.read_bytes()
            assert snap[BASE:BASE+96] == b'\xff'*96
            assert snap[BASE+96:BASE+len(image)] == image[96:]
            assert snap[:BASE] == before[:BASE]
            assert snap[BASE+STAGING:] == before[BASE+STAGING:]
            assert call('POST', '/v1/restore/commit', b'0'*64, 'text/plain')[0] == 409
            assert flash.read_bytes() == snap
            assert call('GET', '/v1/backup') == (200, snap)
            assert cli('status')['state'] == 'verified'
            backup_path = folder/'verified.flash-backup'
            backup_meta = cli('backup', backup_path)
            assert backup_path.read_bytes() == snap
            assert backup_meta['sha256'] == hashlib.sha256(snap).hexdigest()
            cli('backup', backup_path, expected=1)
            assert backup_path.read_bytes() == snap
            checks.append('verified image still uncommitted; read-only backup exact; protected regions unchanged')
            # Restart loses the RAM header/state and never implicitly commits.
            stop()
            start()
            assert call('POST', '/v1/restore/commit', digest.encode(), 'text/plain')[0] == 409
            assert flash.read_bytes() == snap
            checks.append('process restart cannot commit previously uncommitted upload')
            assert cli('stage', folder/'fixture.rbl')['committed'] is False
            assert cli('commit', '--sha256', digest)['state'] == 'committed'
            committed = flash.read_bytes()
            assert committed[BASE:BASE+len(image)] == image
            assert committed[:BASE] == before[:BASE]
            assert committed[BASE+STAGING:] == before[BASE+STAGING:]
            assert status()['state'] == 'committed'
            assert call('POST', '/v1/restore/abort', b'')[0] == 409
            assert stage()[0] == 409
            assert call('POST', '/v1/reboot', b'')[0] == 202
            checks.append('explicit exact-hash commit writes header last; separate reboot callback')
            flash.with_name(flash.name+'.fault').write_bytes(b'host-only fault injection')
            try:
                call('GET', '/v1/backup')
                raise AssertionError('faulty backup should be truncated')
            except http.client.IncompleteRead:
                pass
            assert status()['reboot_available'] is False
            assert call('POST', '/v1/reboot', b'')[0] == 503
            checks.append('post-commit storage fault quarantines reboot and reports unavailability')
            checks.append('CLI status, private backup, no overwrite, stage and explicit commit exercised')
        finally:
            stop()
            log.close()
    (OUT/'maintenance-http.json').write_text(json.dumps({
        'source': 'synthetic package and file-backed flash', 'checks': checks,
        'hardware_contacted': False, 'bootloader_simulated': False,
        'power_loss_recovery_proven': False}, indent=2)+'\n')
    print(f'Maintenance HTTP/core: {len(checks)} integration checks passed; no hardware used.')


if __name__ == '__main__':
    main()

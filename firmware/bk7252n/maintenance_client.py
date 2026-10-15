"""Local maintenance client for a separately provisioned research firmware.

No camera address, default secret, vendor download, automatic discovery, image
packing, bootloader write or automatic reboot. Each mutation is a separate
explicit subcommand. This tool cannot reach maintenance on the stock firmware.
"""
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sys

from ota_preflight import inspect, MAX_FILE


def clean_response(result):
    """Treat the peer as untrusted: never reflect arbitrary string contents."""
    if not isinstance(result, dict):
        raise ValueError('Unexpected maintenance response')
    states = {'disabled', 'idle', 'receiving', 'verified', 'committed', 'error', 'unknown', 'reboot_requested'}
    errors = {'ok', 'restore_disabled', 'invalid_argument', 'invalid_state', 'invalid_rbl_header',
              'out_of_bounds', 'storage_io_error', 'integrity_mismatch', 'incomplete_upload',
              'unknown_error', 'headers', 'authorization', 'length', 'length_required',
              'backup_unavailable', 'content_type', 'digest_required', 'digest_mismatch',
              'not_committed', 'reboot_unavailable', 'route'}
    clean = {}
    for key, value in result.items():
        if key in ('state', 'error', 'result'):
            valid = states if key == 'state' else errors
            if type(value) is str and value in valid:
                clean[key] = value
        elif key in ('boot_contract_verified', 'header_may_be_valid', 'reboot_available'):
            if type(value) is bool:
                clean[key] = value
        elif key in ('received_bytes', 'package_bytes', 'backup_bytes'):
            if type(value) is int and 0 <= value <= MAX_FILE:
                clean[key] = value
    return clean


def exclusive(path, data):
    """Owner-only creation where POSIX modes are supported; never overwrite."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', default='127.0.0.1', help='IPv4 literal; no DNS or proxy')
    p.add_argument('--port', type=int, default=8081)
    p.add_argument('--allow-plaintext-lan', action='store_true',
                   help='Explicitly allow bearer token and backup over trusted LAN HTTP')
    p.add_argument('--token-file', type=Path, required=True,
                   help='Locally generated token; do not paste it into a URL or command')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('new-token')
    sub.add_parser('status')
    backup = sub.add_parser('backup')
    backup.add_argument('output', type=Path)
    upload = sub.add_parser('stage')
    upload.add_argument('rbl', type=Path)
    commit = sub.add_parser('commit')
    commit.add_argument('--sha256', required=True, help='Full trusted stock-package digest')
    sub.add_parser('abort')
    sub.add_parser('reboot')
    return p.parse_args()


def main():
    a = arguments()
    if a.command == 'new-token':
        exclusive(a.token_file, secrets.token_hex(32).encode('ascii'))
        print(json.dumps({'token_created': True, 'contents_printed': False}))
        return
    addr = ipaddress.IPv4Address(a.host)
    if not addr.is_loopback and not (addr.is_private and a.allow_plaintext_lan):
        raise ValueError('LAN HTTP requires --allow-plaintext-lan; public addresses are refused')
    if addr.is_multicast or addr.is_unspecified or not 1 <= a.port <= 65535:
        raise ValueError('Invalid endpoint')
    token = a.token_file.read_text(encoding='ascii').strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise ValueError('Expected a locally generated 64-character token file')
    body = None
    headers = {'Authorization': 'Bearer '+token}
    method = 'GET' if a.command in ('status', 'backup') else 'POST'
    route = {'status': '/v1/status', 'backup': '/v1/backup', 'stage': '/v1/restore',
             'commit': '/v1/restore/commit', 'abort': '/v1/restore/abort', 'reboot': '/v1/reboot'}[a.command]
    if a.command == 'stage':
        with a.rbl.open('rb') as f:
            body = f.read(MAX_FILE+1)
        # Client format check is additional; server's independent pinned SHA
        # and installed-loader contract remain mandatory and cannot be supplied
        # or overridden by this request.
        inspect(body)
        headers['Content-Type'] = 'application/octet-stream'
    elif a.command == 'commit':
        if len(a.sha256) != 64 or any(c not in '0123456789abcdef' for c in a.sha256):
            raise ValueError('Expected a full lower-case SHA256 digest')
        body = a.sha256.encode('ascii')
        headers['Content-Type'] = 'text/plain'
    elif method == 'POST':
        body = b''
    if a.command == 'backup' and (a.output.exists() or a.output.with_name(a.output.name+'.json').exists()):
        raise FileExistsError('Backup or manifest already exists; choose a new path')
    conn = http.client.HTTPConnection(str(addr), a.port, timeout=95)
    try:
        conn.request(method, route, body=body, headers=headers)
        response = conn.getresponse()
        if a.command == 'backup' and response.status == 200:
            value = response.getheader('Content-Length', '')
            if not value.isascii() or not value.isdecimal() or not 0 < int(value) <= MAX_FILE:
                raise ValueError('Invalid backup size')
            expected = int(value)
            temp = a.output.with_name(a.output.name+'.partial')
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            size = 0
            digest = hashlib.sha256()
            # A failed transfer deliberately remains .partial, not a backup.
            with os.fdopen(fd, 'wb') as f:
                while size < expected:
                    chunk = response.read(min(16384, expected-size))
                    if not chunk:
                        raise ValueError('Truncated backup; partial file retained')
                    f.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                f.flush()
                os.fsync(f.fileno())
            # Rename without replacing a backup created by another process.
            os.link(temp, a.output)
            temp.unlink()
            summary = {'bytes': size, 'sha256': digest.hexdigest(),
                       'source': 'physical flash read from running custom application',
                       'pre_migration_backup': False, 'recovery_proven': False,
                       'private_backup': True}
            exclusive(a.output.with_name(a.output.name+'.json'), (json.dumps(summary, indent=2)+'\n').encode())
            print(json.dumps(summary))
            return
        data = response.read(4097)
        if len(data) > 4096:
            raise ValueError('Oversized maintenance response')
        result = json.loads(data)
        clean = clean_response(result)
        clean['http_status'] = response.status
        if a.command == 'stage':
            clean['uploaded_sha256'] = hashlib.sha256(body).hexdigest()
            clean['committed'] = False
        print(json.dumps(clean))
        if response.status >= 400:
            raise SystemExit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, http.client.HTTPException) as exc:
        # Do not print request headers or an untrusted response body.
        print('Maintenance request failed: '+type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)

# SPDX-License-Identifier: Apache-2.0
"""Ingress integration test launcher; never run against a host network."""
import fcntl
import os
import pathlib
import socket
import struct
import subprocess
import sys

if (os.environ.get('INGRESS_SOCKET_TEST') != '1'
        or not pathlib.Path('/.dockerenv').exists()
        or {name for _, name in socket.if_nameindex()} != {'lo'}):
    raise SystemExit('Requires a disposable Docker --network none container; host interfaces must not be modified')

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
    for command, address in [(0x8916, '172.30.32.2'), (0x891c, '255.255.255.255')]:
        request = struct.pack('16sH2s4s8s', b'lo:ingress', socket.AF_INET,
                              b'\0' * 2, socket.inet_aton(address), b'\0' * 8)
        fcntl.ioctl(control, command, request)

result = subprocess.run(['node', '--test', 'scripts/ingress.test.cjs'], timeout=40)
sys.exit(result.returncode)

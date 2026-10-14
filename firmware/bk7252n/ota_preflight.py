"""Offline RBL inspection only. Never fetch, package, send, or flash firmware.

Passing CRCs is not evidence that an image can boot or recover after failure.
No socket/HTTP client or device credentials are used by this module.
"""
import argparse
import hashlib
import json
import pathlib
import struct
import zlib

HEADER = struct.Struct('<4sII16s24s24sIIIII')
MAX_FILE = 4 * 1024 * 1024

def inspect(data: bytes, app_capacity: int | None = None,
            staging_capacity: int | None = None) -> dict:
    if not 96 <= len(data) <= MAX_FILE:
        raise ValueError('RBL length outside inspection bounds')
    tag, algorithm, timestamp, part, version, product, body_crc, raw_hash, raw_size, packed_size, header_crc = HEADER.unpack_from(data)
    if tag != b'RBL\0':
        raise ValueError('Not an application RBL package (QIO/whole flash images forbidden)')
    if zlib.crc32(data[:92]) != header_crc:
        raise ValueError('Header CRC mismatch')
    def string(field):
        if b'\0' not in field: raise ValueError('Unterminated header string')
        value=field.split(b'\0',1)[0]
        if any(c<32 or c>126 for c in value): raise ValueError('Non-printable header string')
        return value.decode('ascii')
    partition=string(part)
    if partition!='app':
        raise ValueError('Only app destination may be inspected for this migration')
    if algorithm!=0x402:
        raise ValueError('Format differs from the observed stock AES256-CBC/LZMA package')
    if not raw_size or raw_size>MAX_FILE or not packed_size or packed_size%16 or packed_size!=len(data)-96:
        raise ValueError('Inconsistent raw/package sizes or AES block alignment')
    if zlib.crc32(data[96:])!=body_crc:
        raise ValueError('Package body CRC mismatch')
    if app_capacity is not None and (app_capacity<=96 or raw_size>app_capacity-96):
        raise ValueError('Raw image exceeds caller-supplied app capacity minus metadata')
    if staging_capacity is not None and (staging_capacity<96 or len(data)>staging_capacity):
        raise ValueError('Package exceeds caller-supplied download capacity')
    return {'format_checks':'passed','sha256':hashlib.sha256(data).hexdigest(),
            'algorithm':hex(algorithm),'destination':partition,'version':string(version),
            'product':string(product),'timestamp':timestamp,'raw_bytes':raw_size,
            'package_bytes':len(data),'raw_fnv32_unverified':hex(raw_hash),
            'app_capacity_supplied':app_capacity is not None,
            'staging_capacity_supplied':staging_capacity is not None,
            'safe_to_flash':False,
            'unresolved':['installed bootloader and exact partitions',
                          'decrypted raw-image verification and execution address',
                          'board bring-up and local provisioning',
                          'power-loss recovery and failed-boot rollback']}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file',type=pathlib.Path)
    parser.add_argument('--app-capacity',type=lambda s:int(s,0))
    parser.add_argument('--staging-capacity',type=lambda s:int(s,0))
    args=parser.parse_args()
    with args.file.open('rb') as f: data=f.read(MAX_FILE+1)
    print(json.dumps(inspect(data,args.app_capacity,args.staging_capacity),indent=2))

if __name__=='__main__': main()

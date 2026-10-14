"""Retain only synthetic fixture's header metadata for diagnosis (no pixels)."""
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); data=p.read_bytes(); offset=2; headers=[]
while offset+4<=len(data):
    marker=data[offset+1]; n=int.from_bytes(data[offset+2:offset+4],'big')
    if n<2 or offset+2+n>len(data): raise ValueError('Invalid fixture')
    payload=data[offset+4:offset+2+n]
    headers.append({'marker':hex(marker),'length':n,'payload':payload.hex()})
    offset+=2+n
    if marker==0xda: break
p.with_suffix('.headers.json').write_text(json.dumps(headers,indent=2))

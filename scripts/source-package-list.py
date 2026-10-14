"""Map installed binary packages from both images to exact Debian source versions."""
# SPDX-License-Identifier: Apache-2.0
import json, pathlib, re, sys

folder = pathlib.Path(sys.argv[1])
sources = set()
for arch in ('amd64', 'arm64'):
    for paragraph in (folder / f'dpkg-status-{arch}').read_text().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in paragraph.splitlines()
                      if ': ' in line and not line.startswith(' '))
        if fields.get('Status') != 'install ok installed':
            continue
        source = fields.get('Source', fields['Package'])
        match = re.fullmatch(r'([a-z0-9+.-]+)(?: \(([^)]+)\))?', source)
        assert match, 'Unexpected package source metadata'
        version = match[2] or fields['Version']
        sources.add((match[1], version))
(folder / 'source-packages.tsv').write_text(''.join(f'{p}\t{v}\n' for p, v in sorted(sources)))
print(json.dumps({'sourcePackages': len(sources), 'architectures': ['amd64', 'arm64']}))

// SPDX-License-Identifier: Apache-2.0
'use strict';
try {
 const h=JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:os').tmpdir(),'jiumu-binding-health.json')));
 const age=Date.now()-h.at;
 process.exitCode=h.listening&&age>=0&&age<30000?0:1;
} catch {process.exitCode=1;}

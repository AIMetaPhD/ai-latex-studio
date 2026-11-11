#!/usr/bin/env node
// Exercise the shipped shell-escape build guard with stand-in compilers.
// Requires Node >=20 and a POSIX shell; no Docker, TeX, network or npm packages.
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const started = 'AILS-W18-STARTED';
const returned = 'AILS-W18-RETURNED';
const canary = 'ails-hb.txt';
const source = readFileSync(join(root, 'infra/docker/Dockerfile.ce'), 'utf8');
const marker = source.indexOf(`\\typeout{${started}}`);
const start = source.lastIndexOf('printf', marker);
const end = source.indexOf('rm -f hbst.*', marker);
if (marker < 0 || start < 0 || end < 0) {
  console.error('INCOMPLETE: cannot identify the shipped proof-2 block');
  process.exit(2);
}
const block = source.slice(start, end).replace(/\\\r?\n\s*/g, '\n')
  .split('/tmp/' + canary).join('./' + canary);
const shell = ['sh', '/bin/sh', '/usr/bin/sh', 'dash'].find((candidate) => {
  const result = spawnSync(candidate, ['-c', 'printf AILSSHOK'], { encoding: 'utf8' });
  return !result.error && result.status === 0 && result.stdout === 'AILSSHOK';
});
if (!shell) {
  console.error('INCOMPLETE: no usable POSIX shell; proof was not executed');
  process.exit(2);
}

const cases = [
  { name: 'early compile failure', output: '! Emergency stop.', code: 1, pass: false },
  { name: 'failure after start marker', output: started, code: 1, pass: false },
  { name: 'shell escape refused', output: `${started}\n${returned}`, code: 0, pass: true },
  { name: 'escape command executed', output: `${started}\n${returned}`, code: 0, pass: false, creates: true },
];
let problems = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'ails-proof2-'));
  try {
    writeFileSync(join(dir, 'pdflatex'), '#!/bin/sh\n' +
      'touch compiler-invoked\n' +
      `printf '%s\\n' '${c.output}'\n` +
      (c.creates ? `touch '${canary}'\n` : '') + `exit ${c.code}\n`);
    chmodSync(join(dir, 'pdflatex'), 0o755);
    // cwd is the sandbox; a relative PATH entry works on both Git Bash and Linux.
    writeFileSync(join(dir, 'run.sh'), 'set -eu\nPATH=".:$PATH"\n' + block + '\n');
    const result = spawnSync(shell, ['run.sh'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    const invoked = existsSync(join(dir, 'compiler-invoked'));
    const created = existsSync(join(dir, canary));
    const passed = !result.error && result.status === 0;
    const ok = !result.error && result.status !== null && invoked &&
      passed === c.pass && created === Boolean(c.creates);
    console.log(`${ok ? 'OK' : 'FAIL'} ${c.name}: invoked=${invoked} exit=${result.status} canary=${created}`);
    if (!ok) {
      problems++;
      console.error(result.error?.message || result.stderr || result.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${cases.length - problems}/${cases.length} proof-control cases passed (stand-in compilers only)`);
process.exitCode = problems ? 1 : 0;

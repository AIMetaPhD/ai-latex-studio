// Zero-dependency regression tests for the shipped operator/build shell blocks.
// Docker and tlmgr are shell stubs; no daemon, TeX, network or files are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const doctor = readFileSync(new URL('../../scripts/doctor.sh', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../infra/docker/Dockerfile.ce', import.meta.url), 'utf8');
const begin = doctor.indexOf('# 8)');
const end = doctor.indexOf('# 10)');
assert.ok(begin >= 0 && end > begin, 'doctor image-check block must exist');
const block = doctor.slice(begin, end);
const bash = ['bash', '/bin/bash'].find((candidate) => {
  const r = spawnSync(candidate, ['-c', 'printf READY'], { encoding: 'utf8' });
  return !r.error && r.status === 0 && r.stdout === 'READY';
});
assert.ok(bash, 'a working bash is required; cannot report a verdict without execution');

function runDoctor({ running = true, missing = false, inspectFailure = false } = {}) {
  const fixture = `
set -uo pipefail
exec 3>&1
line() { printf '%s %s\\n' "$1" "$2"; }
AILS_PREFIX=qa
AILS_CE_TAG=custom
runs=0
docker() {
  case "$1 $2" in
    'container inspect')
      if ${inspectFailure}; then return 2; fi
      if ! ${running}; then return 1; fi
      printf '%s\\n' sha256:running-old
      ;;
    'container ls') ${inspectFailure ? 'return 2' : 'return 0'} ;;
    'image inspect') printf '%s\\n' sha256:configured ;;
    'image ls') printf '%s\\n' ai-latex-studio/ce:other ;;
    'images ai-latex-studio/ce') printf '%s\\n' ai-latex-studio/ce:other ;;
    'inspect qa-ce')
      case "$*" in
        *Config.Env*) printf '%s\\n' AILS_COMPILE_TIMEOUT_MS=180000 ;;
        *) printf '%s\\n' sha256:running-old ;;
      esac
      ;;
    'inspect --type') printf '%s\\n' sha256:running-old ;;
    'run --rm')
      printf 'CHECK_IMAGE %s\\n' "$5" >&3
      case "$*" in
        *kpsewhich*) ${missing ? "printf '%s\\n' MISSING:xcolor.sty TELDONE" : "printf '%s\\n' TELDONE"} ;;
        *) printf '%s\\n' PATCHED ;;
      esac
      ;;
    *) printf 'UNEXPECTED_DOCKER %s\\n' "$*" >&2; return 2 ;;
  esac
}
${block}
`;
  const r = spawnSync(bash, ['-c', fixture], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  assert.doesNotMatch(r.stderr, /UNEXPECTED_DOCKER/, 'fixture must implement every Docker call');
  return r;
}

test('doctor checks the running image ID for both TeX and patches, not the newest tag', () => {
  const r = runDoctor();
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/CHECK_IMAGE sha256:running-old/g) || []).length, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /CHECK_IMAGE .*:other/);
  assert.match(r.stdout, /PASS.*compile deadline/);
});

test('a missing file in the running image fails even if another tag is available', () => {
  const r = runDoctor({ missing: true });
  assert.match(r.stdout, /FAIL.*xcolor\.sty/);
  assert.doesNotMatch(r.stdout, /PASS.*Academic TeX/);
});

test('without a container doctor checks the configured tag and warns runtime is unverified', () => {
  const r = runDoctor({ running: false });
  assert.match(r.stdout, /WARN.*[Uu][Nn][Vv][Ee][Rr][Ii][Ff][Ii][Ee][Dd]/);
  assert.equal((r.stdout.match(/CHECK_IMAGE sha256:configured/g) || []).length, 2, r.stderr);
  assert.doesNotMatch(r.stdout, /PASS.*compile deadline/);
});

test('container inspection failure cannot be reported as deployed verification', () => {
  const r = runDoctor({ inspectFailure: true });
  assert.match(r.stdout, /FAIL.*(?:inspect|image|container)/i);
  assert.doesNotMatch(r.stdout, /PASS.*(?:Academic TeX|patches|deadline)/);
});

test('tlmgr install failure aborts the shipped build block', () => {
  const start = dockerfile.indexOf('    tlmgr install ');
  const finish = dockerfile.indexOf('    mktexlsr;', start);
  assert.ok(start >= 0 && finish > start, 'package installation block must exist');
  const install = dockerfile.slice(start, finish).replace(/\\\r?\n\s*/g, '\n');
  const r = spawnSync(bash, ['-c', `set -e\ntlmgr() { return 23; }\n${install}\nprintf REACHED_AFTER_INSTALL\n`], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /REACHED_AFTER_INSTALL/);
});

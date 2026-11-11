#!/usr/bin/env node
// Adversarial coverage measurement for scripts/scan-secrets.sh, run in a throwaway
// git repo so nothing in the product tree is touched.
//
// Three phases, all with expectations I stated before seeing the result:
//   A  an EMPTY repo must be reported clean without crashing (no fail-open, no false alarm)
//   B  ten credential / private-infrastructure shapes, one file each, attributed per shape
//   C  those files deleted again -> --history must still flag them, and must NOT collapse to
//      zero (a history scan that silently matches nothing is the failure mode that matters)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// usage: node qa/g5/scanner-coverage.mjs [path/to/scan-secrets.sh]
// Zero-dependency and container-free on purpose: this is the part of G5 verification
// that an independent reviewer without Docker can run and re-run.
const SCANNER = process.argv[2] ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/scan-secrets.sh')
if (!fs.existsSync(SCANNER)) {
  console.error(`ERROR: scanner not found at ${SCANNER}`)
  process.exit(2)
}
const run = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', ...opts })

// Synthetic credential-shaped values, assembled at run time. Typing a literal would
// put a credential-shaped string into a tracked file -- the exact thing this gate
// hunts -- and the display layer masks such strings, so a pasted one would land as a
// placeholder and silently make the test vacuous.
const A26 = 'abcdefghijklmnopqrstuvwxyz'
const SYN16 = (seed) => Array.from({ length: 16 }, (_, i) =>
  (i % 5 === 0 ? String((seed + i) % 10) : A26[(seed * 3 + i * 7) % 26])).join('')
const SYN36 = (seed) => Array.from({ length: 36 }, (_, i) =>
  (i % 3 === 0 ? String((seed + i) % 10) : A26[(seed * 5 + i * 3) % 26].toUpperCase())).join('')

// [path, content, what it is, expected]
const PROBES = [
  ['p01_credname.js', `const CRED = '${SYN16(1)}'\n`, 'secret under a name with no password/PASS/TOKEN/SECRET/KEY word', 'MISS'],
  // Written expecting MISS. The first run flagged it HIT via the env-style rule,
  // because the second chunk is on its own 12 chars mixing letters and digits -- so
  // the expectation was revised to HIT with that reason, not the other way round.
  // Splitting a secret is still NOT reliably caught: a 6+6 split would pass, which is
  // why this shape is listed under limits rather than strengths.
  ['p02_concat.js', `const PASS = '${SYN16(2).slice(0, 6)}' + '${SYN16(2).slice(6)}'\n`, 'credential split across a concatenation (long chunks)', 'HIT'],
  ['p03_json.json', `{"adminPassword": "${SYN16(3)}"}\n`, 'credential as a JSON value', 'HIT'],
  ['p04_yaml.yml', `api_key: "${SYN16(4)}"\n`, 'credential as a YAML value', 'HIT'],
  ['p05_b64.txt', Buffer.from(`secret:${SYN16(5)}`).toString('base64') + '\n', 'base64 blob that decodes to a credential', 'MISS'],
  // named .env.* would be skipped: the scratch repo inherits the user's global
  // gitignore, and an untracked probe would read as a scanner MISS that is really
  // "the scanner never looked". production.env is tracked and is the same shape.
  ['config/production.env', `SECRET_KEY=${SYN16(6)}\nADMIN_EMAIL=a@b.c\n`, 'unquoted env-style assignment in a dotenv file', 'HIT'],
  ['p07_header.sh', `curl -H "Authorization: Bearer ghp_${SYN36(7)}"\n`, 'GitHub-token-shaped string inside a header', 'HIT'],
  ['p08_prose.md', `The admin password is ${SYN16(8)} and it never changes.\n`, 'credential in plain prose', 'MISS'],
  ['p09_jsenv.js', `process.env.PASSWORD = '${SYN16(9)}'\n`, 'literal assigned onto process.env in source', 'HIT'],
  ['p10_multiline.js', `const PASS =\n  '${SYN16(10)}'\n`, 'credential on the following line (line-oriented scanner)', 'MISS'],
  // The limit p02 exposes, sized honestly: 6-char fragments still trip the env-style
  // rule (measured), so this one splits the same secret into four 4-char pieces --
  // no fragment long enough to look like anything. MISS here is a real gap, not a bug.
  ['p11_split_short.js', `const PASS = '${SYN16(11).slice(0, 4)}' + '${SYN16(11).slice(4, 8)}' + '${SYN16(11).slice(8, 12)}' + '${SYN16(11).slice(12)}'\n`, 'credential split into four 4-char fragments', 'MISS'],
]

// Our own address, port and queue binary are assembled at run time instead of written
// out: this file is tracked, and pasting them in would make the release gate flag the
// test that exists to protect the gate (measured -- a literal here produced 4 findings
// on `scan-secrets.sh`, caught before commit). The same trick qa/g0/restore-e2e.sh uses
// for its fixture address. The remaining addresses are synthetic RFC1918 examples.
const OWN = [100, 111, 90, 123].join('.')
const QPORT = [9, 1, 1, 0].join('')
const QBIN = ['queue', 'client'].join('_')
const TLD = [OWN, '10.8.0.5', '192.168.1.20', '172.16.3.4']
const TRUSTED = [
  ['infra/docker/compose.yml', 'ports:\n  - "127.0.0.1:8081:8080"\n  - "127.0.0.1:11434:11434"\n'],
  ['docs/SECURITY.md', 'The SSRF denylist blocks 100.64.0.0/10 and 127.0.0.0/8.\n'],
  ['scripts/doctor.sh', 'curl -s http://127.0.0.1:11434/api/tags\n'],
]
// [file, content, mustBeFlagged, why]
// The gate's job is OUR infrastructure detail: the an internal overlay network range this machine lives
// on and the queue's port/binary name. RFC1918 ranges are a documented scope limit --
// a blanket 10./192.168./172. rule would flag the SSRF denylist itself
// (['10.0.0.0', 8] in services/ai-sidecar/src/ssrf.mjs is a denylist entry, not a
// leak), so the harness reports those as expected misses instead of pretending they
// are caught.
const MALICIOUS = [
  ['infra/scripts/deploy.sh', `curl -s http://${OWN}:${QPORT}/tasks\n`, true, 'own an internal overlay network host + queue port'],
  ['qa/notes.md', 'the queue lives at 10.8.0.5 behind the tunnel\n', false, 'RFC1918 -- documented scope limit'],
  ['web/ui/app.js', 'fetch("http://192.168.1.20/api")\n', false, 'RFC1918 -- documented scope limit'],
  ['ops/run.sh', 'ssh admin@172.16.3.4\n', false, 'RFC1918 -- documented scope limit'],
  ['tools/sync.md', `run ${QBIN}.py --role producer against the tunnel host\n`, true, 'queue binary name'],
]

const REPO = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scanprobe-'))
// The scanner's private-infrastructure half now lives in an operator-owned file
// (scripts/scan-secrets.local.sh, gitignored) so the shipped repo does not name our
// tunnel range, queue port or binary. The harness supplies its own site rules, built
// from the same run-time constants, written OUTSIDE the scratch repo so `git add -A`
// can never track it.
const SITE_RULES = path.join(path.dirname(REPO), 'site-rules.txt')
fs.writeFileSync(SITE_RULES,
  `SITE_ENDPOINT_RULE=${OWN.split('.').slice(0, 2).join('\\.')}\\.|:${QPORT}|${QBIN}\n`)
const genv = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
  AILS_SCAN_SITE_RULES: SITE_RULES,
}
// `git commit` exits 1 for a perfectly ordinary reason: nothing to commit. That is
// not a measurement failure, so it must not abort the run -- the history phase still
// has the earlier commit to find.
const git = (cmd) => {
  try {
    run(`git ${cmd}`, { cwd: REPO, env: genv, stdio: 'ignore' })
    return ''
  } catch {
    return ''
  }
}
const gitFails = (cmd) => {
  try {
    run(`git ${cmd}`, { cwd: REPO, env: genv, stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}
// separate helper for the calls whose stdout is the measurement
const gitOut = (cmd) => {
  try {
    return run(`git ${cmd}`, { cwd: REPO, env: genv })
  } catch {
    return ''
  }
}
function scan (args) {
  // A scanner that finds something exits 1 -- that is the result, not a crash.
  try {
    return run(`bash scripts/scan-secrets.sh ${args}`, { cwd: REPO, env: genv, maxBuffer: 1 << 26 })
  } catch (e) {
    return String((e && e.stdout) || '')
  }
}
fs.mkdirSync(path.join(REPO, 'scripts'), { recursive: true })
fs.copyFileSync(SCANNER, path.join(REPO, 'scripts', 'scan-secrets.sh'))

const problems = []
const note = (phase, msg) => { problems.push(`${phase}: ${msg}`); console.log(`  !! ${phase}: ${msg}`) }
const selfTestOk = (out) => {
  const line = (out.match(/self-test [^\n]*/) || [''])[0]
  return !/FAIL/.test(line) && /detects-canary=ok/.test(line)
}
// find which rule matched `needle`, in an indented `path:line:content` listing
function matchedRule (out, needle) {
  let rule = null
  for (const line of out.split('\n')) {
    const h = line.match(/^HIT\s+\(\s*\d+\)\s+(.*)$/)
    if (h) { rule = h[1].trim(); continue }
    if (/^(clean|scope:|self-test|scan-secrets:)/.test(line)) { if (!/^HIT/.test(line)) rule = line.startsWith('clean') ? null : rule }
    if (rule && line.includes(needle)) return rule
  }
  return null
}

// ---- phase A: empty repo -----------------------------------------------------
console.log('=== A. empty repo (nothing tracked but the scanner itself) ===')
git('init -q .')
git('add -A')
git('-c user.email=t@t -c user.name=t commit -qm baseline')
const a = scan('')
if (!/scan-secrets:/.test(a)) note('A', 'no verdict printed at all -- measurement would be meaningless')
if (!selfTestOk(a)) note('A', 'self-test did not pass in an empty repo')
if (/HIT/.test(a) || !/clean \(tree\)/.test(a)) {
  console.log(a.split('\n').filter(l => /HIT|clean  |scan-secrets:/.test(l)).join('\n'))
  note('A', 'empty repo was not reported clean(tree)')
} else console.log('  ok: prints a verdict, self-test all ok, "clean (tree)", exit code 0')

// A2: the gate must refuse to look clean when the operator's site rules are absent.
// Otherwise a missing file silently downgrades the release check to generic shapes.
const noSite = (() => {
  const e = { ...genv, AILS_SCAN_SITE_RULES: path.join(REPO, 'no-such-rules.txt') }
  try {
    return { code: 0, out: run('bash scripts/scan-secrets.sh', { cwd: REPO, env: e, maxBuffer: 1 << 26 }) }
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') }
  }
})()
const refused = noSite.code !== 0 && /INCOMPLETE/.test(noSite.out) && !/clean \(tree\)/.test(noSite.out)
console.log(`  A2 site rules absent -> exit ${noSite.code}, INCOMPLETE and not clean: ${refused ? 'yes (fail-closed)' : 'NO'}`)
if (!refused) note('A2', `missing site rules did not fail closed (exit ${noSite.code})`)

// A3: the gate reads everything through git (`git grep`, `git log`). In a directory
// that is not a repo each rule returns empty and the run prints "clean" for a scan
// that inspected nothing. Measured 2026-11-04: a scratch dir holding a literal
// password and an sk- key reported clean (tree), exit 0. Must be INCOMPLETE + exit 2.
const notARepo = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ails-norepo-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts/scan-secrets.sh'), path.join(dir, 'scripts/scan-secrets.sh'))
  fs.copyFileSync(SITE_RULES, path.join(dir, 'scripts/scan-secrets.local.sh'))
  // two obvious secrets in a plain file, exactly what the tree scan exists to catch.
  // Built at runtime: a literal here would put a credential-shaped string into a
  // tracked file -- the thing this gate hunts -- and it did (3 findings on my first
  // version of this block).
  fs.writeFileSync(path.join(dir, 'leaked.txt'),
    `password: "${SYN16(90)}"\nsk-${SYN36(91)}\n`)
  try {
    return { code: 0, out: run('bash scripts/scan-secrets.sh', { cwd: dir, env: genv, maxBuffer: 1 << 26 }) }
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const blocked = notARepo.code === 2 && /INCOMPLETE/.test(notARepo.out) && !/clean \(tree\)/.test(notARepo.out)
console.log(`  A3 not a git repo -> exit ${notARepo.code}, INCOMPLETE and not clean: ${blocked ? 'yes (fail-closed)' : 'NO'}`)
if (!blocked) note('A3', `a non-repo directory was not refused (exit ${notARepo.code}) -- the gate can report clean on a scan that read nothing`)

// A4: a repo with ZERO commits. Measured 2026-11-04: the pre-fix scanner exited 0
// here -- a history verdict for a scan that examined no history. Same vacuous-clean
// class as A3, reached by a different route.
// Provenance: found by taking an independent reviewer's review claim ("MSG_FAIL is set but never
// consumed") and testing it instead of accepting or dismissing it. Its stated
// mechanism did not reproduce (MSG_FAIL IS consumed), but the effect did.
// Measurement caveat, stated rather than smoothed over: I first recorded
// `git log --all`'s exit status here and got 1, which contradicted a hand-made repo
// giving 0. The difference was my own harness, not git: execSync goes through
// cmd.exe on Windows, where `> /dev/null` is not a real path, so that probe measured
// a redirection failure. The probe is dropped; this phase asserts the VERDICT only,
// and the before/after control is what carries the claim: pre-fix exit 0, fixed
// exit 2, same scenario.
const emptyRepo = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ails-emptyrepo-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts/scan-secrets.sh'), path.join(dir, 'scripts/scan-secrets.sh'))
  fs.copyFileSync(SITE_RULES, path.join(dir, 'scripts/scan-secrets.local.sh'))
  const g = (cmd) => { try { return run(cmd, { cwd: dir, env: genv }) } catch (e) { return '' } }
  g('git init -q .')
  const commits = g('git rev-list --all --count').trim()
  try {
    return { commits, code: 0, out: run('bash scripts/scan-secrets.sh --history', { cwd: dir, env: genv, maxBuffer: 1 << 26 }) }
  } catch (err) {
    return { commits, code: err.status, out: String(err.stdout || '') + String(err.stderr || '') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const emptyBlocked = emptyRepo.code === 2 && /INCOMPLETE/.test(emptyRepo.out) && !/clean \(history\)/.test(emptyRepo.out)
console.log(`  A4 zero-commit repo (commits=${emptyRepo.commits}) -> --history exit ${emptyRepo.code}, INCOMPLETE: ${emptyBlocked ? 'yes (fail-closed)' : 'NO'}`)
if (!emptyBlocked) note('A4', `a zero-commit repo produced a history verdict instead of INCOMPLETE (exit ${emptyRepo.code})`)

// A5: the self-test's own credibility. Its negative half asserts "this shape must NOT
// be flagged"; `grep -c` on a missing file yields 0, which is exactly what "must not
// be flagged" expects. So a missing fixture made the assertion pass vacuously and the
// run then said clean on the strength of it. Raised as S6 in an independent reviewer's review and
// reproduced 2026-11-04: delete only the good.txt write -> whitelist-holds=ok, clean.
// The gate now checks fixture integrity before judging, so this must exit 1.
const vacuous = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ails-vacuous-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  const src = fs.readFileSync(path.join(REPO, 'scripts/scan-secrets.sh'), 'utf8')
  // drop just the good.txt fixture write; every assertion stays as shipped
  const broken = src.split('\n').filter((l) => !(l.includes('good.txt') && l.includes('printf'))).join('\n')
  fs.writeFileSync(path.join(dir, 'scripts/scan-secrets.sh'), broken)
  fs.copyFileSync(SITE_RULES, path.join(dir, 'scripts/scan-secrets.local.sh'))
  try { run('git init -q .', { cwd: dir, env: genv }) } catch { /* checked below */ }
  try {
    return { removed: src.split('\n').length - broken.split('\n').length, code: 0, out: run('bash scripts/scan-secrets.sh', { cwd: dir, env: genv, maxBuffer: 1 << 26 }) }
  } catch (err) {
    return { removed: src.split('\n').length - broken.split('\n').length, code: err.status, out: String(err.stdout || '') + String(err.stderr || '') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const vacuousCaught = vacuous.code === 1 && /SELF-TEST FAILED/.test(vacuous.out) && /fixtures=FAIL/.test(vacuous.out)
console.log(`  A5 one fixture write removed (${vacuous.removed} line) -> exit ${vacuous.code}, SELF-TEST FAILED + fixtures=FAIL: ${vacuousCaught ? 'yes' : 'NO'}`)
if (!vacuousCaught) note('A5', 'a missing self-test fixture did not fail the self-test -- its negative assertions can pass vacuously')

// A6: a rule whose pattern makes `git grep` ERROR (exit >=2) used to be read as "no
// match", so the run printed clean. Raised as S1/S3 in an independent reviewer's matcher review.
// Measured: `git grep -e '*'` exits 128 here; `|| true` turned that into zero hits.
// Scope note, stated because it matters: the same bad pattern is treated as a MATCH
// by git grep in --history mode (3393 hits), so this phase covers the tree path only
// and does not claim history-mode error detection.
const badPattern = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ails-badere-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts/scan-secrets.sh'), path.join(dir, 'scripts/scan-secrets.sh'))
  fs.writeFileSync(path.join(dir, 'scripts/scan-secrets.local.sh'), 'SITE_ENDPOINT_RULE=*\n')
  try { run('git init -q .', { cwd: dir, env: genv }) } catch { /* checked below */ }
  const env = { ...genv, AILS_SCAN_SITE_RULES: path.join(dir, 'scripts/scan-secrets.local.sh') }
  try {
    return { code: 0, out: run('bash scripts/scan-secrets.sh', { cwd: dir, env, maxBuffer: 1 << 26 }) }
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()
const ereCaught = badPattern.code === 2 && /INCOMPLETE/.test(badPattern.out) && /rule\(s\) errored/.test(badPattern.out)
console.log(`  A6 rule that makes git grep error -> exit ${badPattern.code}, INCOMPLETE: ${ereCaught ? 'yes (fail-closed)' : 'NO'}`)
if (!ereCaught) note('A6', 'a rule whose pattern errors was reported as no-match instead of INCOMPLETE')

// ---- phase B: ten credential shapes + endpoint/trusted tests -----------------
console.log('\n=== B. injected shapes (expectations fixed before this run) ===')
for (const [f, body] of [...PROBES, ...TRUSTED, ...MALICIOUS]) {
  const p = path.join(REPO, f)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
git('add -A')
git('-c user.email=t@t -c user.name=t commit -qm probes')
// A probe the repo never tracked (a global gitignore excluding .env*, say) would show
// up as a MISS and look like a scanner gap. Check tracking before judging coverage.
const tracked = new Set(gitOut('ls-files').split('\n').map(s => s.trim()).filter(Boolean))
for (const [f] of [...PROBES, ...TRUSTED, ...MALICIOUS]) {
  if (!tracked.has(f)) note('B', `${f} is NOT tracked by the scratch repo -- its result would be meaningless`)
}
const b = scan('--verbose')
if (!selfTestOk(b)) note('B', 'self-test failed in the injected repo')
let wrong = 0
for (const [f, , what, expected] of PROBES) {
  const rule = matchedRule(b, f.split('/').pop())
  const got = rule ? 'HIT' : 'MISS'
  const ok = got === expected
  if (!ok) wrong++
  console.log(`  ${f.padEnd(20)} expect ${expected.padEnd(5)} got ${got.padEnd(5)} ${rule || ''}${ok ? '' : '   <-- WRONG: ' + what}`)
  if (!ok) note('B', `${f}: expected ${expected}, got ${got}`)
}
console.log('  -- trusted-loopback references (must NOT be flagged):')
for (const [f] of TRUSTED) {
  const rule = matchedRule(b, f.split('/').pop())
  console.log(`  ${f.padEnd(26)} ${rule ? 'FLAGGED as ' + rule : 'not flagged (correct)'}`)
  if (rule) note('B', `false positive on trusted loopback file ${f}`)
}
console.log('  -- private infrastructure:')
for (const [f, body, must, why] of MALICIOUS) {
  // pattern assembled from the same constants, so this file never carries the literal
  // endpoint / binary name it is testing for
  const shape = new RegExp(QBIN + '|\\d+\\.\\d+\\.\\d+\\.\\d+')
  const key = body.match(shape)[0]
  const rule = matchedRule(b, key)
  const got = rule ? 'flagged' : 'not flagged'
  console.log(`  ${f.padEnd(26)} ${key.padEnd(15)} ${got.padEnd(12)} ${must ? 'required' : 'accepted'} -- ${why}`)
  if (must && !rule) note('B', `missed in-scope private detail ${key} in ${f}`)
  if (!must && rule) console.log(`     (note: this shape is now caught (${rule}); the scope comment could be tightened)`)
}

// ---- phase C: deleted again, history must still remember ---------------------
// Everything that was a finding goes; only the trusted loopback files stay. The tree
// must then be clean, while --history must still flag the deleted content -- that
// difference is the whole reason a clean tree is not enough before publishing.
console.log('\n=== C. findings deleted, then compared tree vs --history ===')
// unlinkSync, not rmSync: measured on node 24.12 / Windows 11, fs.rmSync(path,
// {force:true}) returns without removing the file, which would let this phase
// "verify history" while nothing was ever deleted. Assert each one really went away.
const gone = []
for (const [f] of [...PROBES, ...MALICIOUS]) {
  const fp = path.join(REPO, f)
  try { fs.unlinkSync(fp) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!fs.existsSync(fp)) gone.push(f)
}
console.log(`  deleted ${gone.length}/${PROBES.length + MALICIOUS.length} finding files from the tree`)
if (gone.length !== PROBES.length + MALICIOUS.length) note('C', 'some finding files could not be deleted; phase C inconclusive')
git('add -A')
if (gitFails('-c user.email=t@t -c user.name=t commit -qm remove-findings')) note('C', 'the deletion commit did not happen; phase C is meaningless')
const tree = scan('')
const hist = scan('--history --verbose')
if (!selfTestOk(hist)) note('C', 'self-test failed in history mode')
// "clean (tree)" carries no number, and a -1 there would quietly invert a comparison
const nOf = s => Number((s.match(/scan-secrets: (\d+) finding/) || [])[1] ?? (/scan-secrets: clean/.test(s) ? 0 : -1))
const treeClean = /clean \(tree\)/.test(tree)
// verbose history lines are indented and prefixed with the commit: "          <rev>:<path>:<line>:<content>"
const histFiles = new Set((hist.match(/^ {6,}\w{7,}:(\S+):\d+:/gm) || []).map(l => l.split(':')[1]))
let stillFound = 0
for (const [f] of PROBES) if (histFiles.has(f)) stillFound++
console.log(`  tree after deletion: ${treeClean ? 'clean' : 'STILL DIRTY'}; findings tree=${nOf(tree)} history=${nOf(hist)}`)
console.log(`  --history still flags ${stillFound}/${PROBES.length} of the deleted probe files`)
if (!treeClean) note('C', `tree not clean after deleting findings: ${tree.split('\n').filter(l => /^ +\S+:\d+:/.test(l)).join(', ').slice(0, 200)}`)
if (stillFound === 0) note('C', 'history scan matched nothing -- vacuous')
if (nOf(hist) <= nOf(tree)) note('C', `history (${nOf(hist)}) should report more than the tree (${nOf(tree)}) once findings only exist in commits`)

// ---- phase D: the commit-message surface -------------------------------------
// `git grep <rev>` reads file contents per revision, so a pattern that appears ONLY
// in a commit message is invisible to a file-based history scan -- and `git push`
// ships messages anyway. Found 2026-11-04 by measuring my own dispatch-log commits.
// This builds a commit whose files are clean and whose message is not.
console.log('\n=== D. commit messages (invisible to git grep) ===')
// Back to a clean tree, then one commit whose files are clean and whose MESSAGE
// carries an endpoint-shaped literal no file contains.
for (const f of [...PROBES, ...MALICIOUS].map(([f]) => f)) {
  const p = path.join(REPO, f)
  if (fs.existsSync(p)) fs.rmSync(p, { force: true })
}
git('add -A')
git('-c user.email=t@t -c user.name=t commit -qm "remove probes"')
// Shaped like the generic CGNAT endpoint rule: http://100.<64-127>.x.x
const msgNeedle = 'http://' + OWN + '/jobs'
run('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "docs: internals at ' + msgNeedle + '"', { cwd: REPO })
// scan() takes a STRING and returns a STRING (it swallows the nonzero exit that means
// "findings found"), so it cannot report an exit code. Use a local runner that keeps both.
function scanWithCode (argString) {
  try {
    return { code: 0, out: run(`bash scripts/scan-secrets.sh ${argString}`, { cwd: REPO, env: genv, maxBuffer: 1 << 26 }) }
  } catch (e) {
    return { code: e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') }
  }
}
const dTree = scanWithCode('')
const dHist = scanWithCode('--history --verbose')
const treeSaysClean = dTree.code === 0 && /clean \(tree\)/.test(dTree.out)
// Assert on the VERDICT, not on the literal appearing in stdout: non-verbose output
// groups by path and never echoes matched text, so a text search can only false-fail.
const histFlagsEndpoint = dHist.code === 1 && /HIT\s+\(\s*\d+\)\s+home network endpoint/.test(dHist.out)
const msgHitShown = dHist.out.includes(msgNeedle)
console.log(`  files clean, one message carries ${msgNeedle}`)
console.log(`  tree scenario valid (files clean, exit 0): ${treeSaysClean ? 'yes' : 'NO -- scenario broken, the D result below is meaningless'}`)
console.log(`  --history exit ${dHist.code}, flags the endpoint rule: ${histFlagsEndpoint ? 'yes' : 'NO'}`)
console.log(`  --verbose shows the message line itself: ${msgHitShown ? 'yes' : 'NO'}`)
if (!treeSaysClean) note('D', 'scenario invalid: tree not clean before judging the message surface')
else if (!histFlagsEndpoint || !msgHitShown) note('D', 'a secret-shaped literal in a commit message was not found by --history')

console.log('\n=== verdict ===')
console.log(`expectations that did not hold: ${wrong}/${PROBES.length}`)
if (problems.length === 0) {
  console.log('COVERAGE MEASUREMENT: all phases behaved as expected')
  fs.rmSync(REPO, { recursive: true, force: true })
} else {
  console.log(`COVERAGE MEASUREMENT: ${problems.length} problem(s)`)
  console.log('repo kept for inspection: ' + REPO)
  process.exit(1)
}

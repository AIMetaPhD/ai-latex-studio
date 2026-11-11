// Compare two exported project ZIPs file-by-file (content, not zip metadata).
// Usage: node qa/g2/compare-zips.mjs <a.zip> <b.zip>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [a, b] = process.argv.slice(2)
if (!a || !b) { console.error('usage: compare-zips.mjs <a.zip> <b.zip>'); process.exit(2) }

function unzip(zip, out) {
  fs.rmSync(out, { recursive: true, force: true })
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${path.resolve(zip)}' -DestinationPath '${path.resolve(out)}' -Force`])
}
const walk = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const map = d => Object.fromEntries(walk(d).map(f => [
  path.relative(d, f).split(path.sep).join('/'),
  crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
]))

const outA = a + '.x', outB = b + '.x'
unzip(a, outA); unzip(b, outB)
const A = map(outA), B = map(outB)
let ok = Object.keys(A).length === Object.keys(B).length
for (const k of Object.keys(A)) {
  if (A[k] !== B[k]) { ok = false; console.log('DIFF', k, A[k].slice(0, 12), '!=', B[k].slice(0, 12)) }
}
for (const k of Object.keys(B)) if (!(k in A)) { ok = false; console.log('ONLY-B', k) }
console.log('files:', Object.keys(A).join(', '))
console.log('CONTENT_IDENTICAL=' + ok)
fs.rmSync(outA, { recursive: true, force: true }); fs.rmSync(outB, { recursive: true, force: true })
process.exit(ok ? 0 : 1)

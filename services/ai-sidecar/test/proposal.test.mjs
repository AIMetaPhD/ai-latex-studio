// Unit tests for the proposal validator (G4 safety rules). No network, no server:
// any Node >= 20 can run this file against the shipped source only.
//   node --test services/ai-sidecar/test/proposal.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProposal, findSpan, deriveAnchors, extractJsonObject, sha256 } from '../src/proposal.mjs'

const DOC = 'A\\cite{x} mid organised end\\nlast'
const base = p => ({
  filePath: 'main.tex',
  baseDocSha256: sha256(DOC),
  oldText: 'organised',
  newText: 'organized',
  anchorBefore: DOC.slice(Math.max(0, DOC.indexOf('organised') - 40), DOC.indexOf('organised')),
  anchorAfter: DOC.slice(DOC.indexOf('organised') + 'organised'.length, DOC.indexOf('organised') + 40 + 'organised'.length),
  rationale: 'test',
  ...p,
})

test('a well-formed single-occurrence proposal validates', () => {
  const r = validateProposal(base(), DOC)
  assert.equal(r.ok, true)
  assert.equal(DOC.slice(r.offset, r.offset + r.length), 'organised')
})

test('missing oldText is rejected', () => {
  const r = validateProposal(base({ oldText: 'nope-not-in-doc' }), DOC)
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('OLD_TEXT_NOT_FOUND'))
})

test('ambiguous oldText is rejected', () => {
  const two = 'organised and organised'
  const p = base({ oldText: 'organised', anchorBefore: '', anchorAfter: '' })
  const r = validateProposal(p, two)
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('OLD_TEXT_NOT_UNIQUE'))
})

test('path traversal and absolute paths are rejected', () => {
  for (const fp of ['../secret.tex', '/etc/passwd', 'C:/windows/x.tex', 'a.pdf']) {
    const r = validateProposal(base({ filePath: fp }), DOC)
    assert.equal(r.ok, false, fp)
  }
})

test('oversized edit is rejected', () => {
  const r = validateProposal(base({ newText: 'x'.repeat(64 * 1024 + 10) }), DOC)
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('EDIT_TOO_LARGE'))
})

test('whitespace-only drift still matches uniquely (model quoting quirk)', () => {
  const doc = 'alpha   beta\ngamma'
  const s = findSpan(doc, 'alpha beta gamma')
  assert.ok(s, 'should find the span')
  assert.equal(doc.slice(s.offset, s.offset + s.length), 'alpha   beta\ngamma')
})

test('anchors must be adjacent to the found text', () => {
  const r = validateProposal(base({ anchorBefore: 'TOTALLY WRONG' }), DOC)
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('ANCHOR_BEFORE_MISMATCH'))
})

test('empty anchors are allowed (locator hint); uniqueness still guards', () => {
  const r = validateProposal(base({ anchorBefore: '', anchorAfter: '' }), DOC)
  assert.equal(r.ok, true, 'oldText uniqueness is the safety property, anchors are locators')
})

test('server-side fresh-hash enforcement blocks a stale proposal', () => {
  const p = base()
  assert.equal(validateProposal(p, DOC, { requireFreshHash: true }).ok, true)
  const stale = validateProposal(p, DOC + ' <- user typed meanwhile', { requireFreshHash: true })
  assert.equal(stale.ok, false)
  assert.ok(stale.errors.includes('BASE_HASH_MISMATCH'))
  const missing = validateProposal({ ...p, baseDocSha256: '' }, DOC, { requireFreshHash: true })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.includes('BASE_HASH_MISSING'))
  // generation path has no "current" doc yet, so the hash rule is opt-in
  assert.equal(validateProposal(p, DOC).ok, true)
})

test('deriveAnchors is consistent with the validator', () => {
  const off = DOC.indexOf('organised')
  const a = deriveAnchors(DOC, off, 'organised'.length)
  assert.ok(a.anchorBefore.endsWith('mid '))
  assert.ok(a.anchorAfter.startsWith(' end'))
  const r = validateProposal(base({ anchorBefore: a.anchorBefore, anchorAfter: a.anchorAfter }), DOC)
  assert.equal(r.ok, true)
})

test('extractJsonObject survives fences and prose but not garbage', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('Sure! {"a":1} hope that helps'), { a: 1 })
  assert.deepEqual(extractJsonObject('{"a":{"b":2}} tail'), { a: { b: 2 } })
  assert.equal(extractJsonObject('no json here'), null)
  assert.equal(extractJsonObject('{"unbalanced": '), null)
})

test('extractJsonObject respects escaped quotes inside strings', () => {
  const p = extractJsonObject('prefix {"a":"say \\"hi\\" then }"} suffix')
  assert.deepEqual(p, { a: 'say "hi" then }' })
})

test('sha256 is stable', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

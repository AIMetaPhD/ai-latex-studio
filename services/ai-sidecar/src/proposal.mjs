// Structured edit proposals (G4). The model never writes files: it returns JSON
// that we validate here, and the browser applies it through CodeMirror's own
// transaction pipeline after re-checking the document hash.
//
// Proposal contract (validated field by field):
//   { filePath, baseDocSha256, oldText, newText, anchorBefore, anchorAfter, rationale }
// Rules enforced below:
//   * path: relative, no "..", LaTeX-ish extension, length bound
//   * sizes: document and edit text bounded (no whole-document rewrites)
//   * oldText must occur EXACTLY ONCE in the base document (anchor uniqueness)
//   * anchors must be adjacent to oldText and short
//   * sha256 of the base document is computed server-side, not trusted from input
import crypto from 'node:crypto'

export const LIMITS = {
  maxDocBytes: 2 * 1024 * 1024,     // 2 MB of .tex text
  maxEditBytes: 64 * 1024,          // 64 KB per proposed replacement
  maxRationale: 2000,
  maxAnchor: 200,
}

export const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// Models sometimes wrap JSON in ```json fences or add prose despite the format
// hint. Extract the first balanced JSON object; never "repair" field values.
export function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

const ALLOWED_EXT = /\.(tex|bib|sty|cls|txt)$/i

export function validatePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return 'PATH_MISSING'
  if (filePath.length > 200) return 'PATH_TOO_LONG'
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) return 'PATH_ABSOLUTE'
  if (filePath.split('/').includes('..')) return 'PATH_TRAVERSAL'
  if (!ALLOWED_EXT.test(filePath)) return 'PATH_EXTENSION'
  return null
}

// Models often normalize line breaks when quoting LaTeX. Find oldText exactly
// first; otherwise allow whitespace-only differences and report the REAL span in
// the document (the replacement still uses the document's own text, never the
// model's copy). Returns { offset, length } or null. Ambiguity is a hard null.
export function findSpan(docText, oldText) {
  const exact = docText.indexOf(oldText)
  if (exact !== -1) {
    const second = docText.indexOf(oldText, exact + 1)
    return second === -1 ? { offset: exact, length: oldText.length } : null
  }
  const norm = s => s.replace(/\s+/g, ' ')
  const target = norm(oldText)
  if (!target.trim()) return null
  // slide a window over normalized text, tracking original offsets
  const parts = []
  let i = 0
  const re = /\S+/g
  let m
  const tokens = []
  while ((m = re.exec(docText))) tokens.push({ start: m.index, end: m.index + m[0].length })
  if (!tokens.length) return null
  const targetTokens = target.trim().split(' ')
  const n = targetTokens.length
  for (let k = 0; k + n <= tokens.length; k++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (docText.slice(tokens[k + j].start, tokens[k + j].end) !== targetTokens[j]) { ok = false; break }
    }
    if (!ok) continue
    const start = tokens[k].start
    const end = tokens[k + n - 1].end
    // continue scanning to detect a second match (ambiguity)
    for (let k2 = k + 1; k2 + n <= tokens.length; k2++) {
      let ok2 = true
      for (let j = 0; j < n; j++) {
        if (docText.slice(tokens[k2 + j].start, tokens[k2 + j].end) !== targetTokens[j]) { ok2 = false; break }
      }
      if (ok2) return null
    }
    return { offset: start, length: end - start }
  }
  return null
}

export function validateProposal(p, docText, { requireFreshHash = false } = {}) {
  const errs = []
  const pe = validatePath(p?.filePath); if (pe) errs.push(pe)
  if (typeof p?.oldText !== 'string' || p.oldText.length === 0) errs.push('OLD_TEXT_EMPTY')
  if (typeof p?.newText !== 'string') errs.push('NEW_TEXT_MISSING')
  if (typeof p?.rationale !== 'string' || !p.rationale.trim()) errs.push('RATIONALE_MISSING')
  // v1.2 requires "any full-document hash mismatch blocks the write". Enforce it
  // here as well as in the client: the server is the authority, the browser check
  // is only UX. (Gap found by independent review, an independent reviewer, 2026-10-29.)
  if (requireFreshHash) {
    if (typeof p?.baseDocSha256 !== 'string' || !p.baseDocSha256) errs.push('BASE_HASH_MISSING')
    else if (p.baseDocSha256 !== sha256(docText)) errs.push('BASE_HASH_MISMATCH')
  }
  if (Buffer.byteLength(docText ?? '', 'utf8') > LIMITS.maxDocBytes) errs.push('DOC_TOO_LARGE')
  if (Buffer.byteLength(p?.newText ?? '', 'utf8') > LIMITS.maxEditBytes) errs.push('EDIT_TOO_LARGE')
  if ((p?.rationale ?? '').length > LIMITS.maxRationale) errs.push('RATIONALE_TOO_LONG')
  for (const k of ['anchorBefore', 'anchorAfter']) {
    if (typeof p?.[k] !== 'string') errs.push(`${k.toUpperCase()}_MISSING`)
    else if (p[k].length > LIMITS.maxAnchor) errs.push(`${k.toUpperCase()}_TOO_LONG`)
  }
  if (errs.length) return { ok: false, errors: errs }

  // exactly one occurrence of oldText in the current document (whitespace-tolerant)
  const span = findSpan(docText, p.oldText)
  if (!span) {
    const exact = docText.indexOf(p.oldText)
    errs.push(exact === -1 ? 'OLD_TEXT_NOT_FOUND' : 'OLD_TEXT_NOT_UNIQUE')
  }

  // anchors are redundant locator hints: the safety property is that oldText
  // matches EXACTLY ONCE. An empty anchor means "no locator given at the document
  // edge" (offset 0 / end of doc) and is therefore allowed, not a bypass — a
  // wrong-but-non-empty anchor is still rejected above.
  if (span && p.anchorBefore) {
    const preceding = docText.slice(Math.max(0, span.offset - p.anchorBefore.length), span.offset)
    if (preceding !== p.anchorBefore) errs.push('ANCHOR_BEFORE_MISMATCH')
  }
  if (span && p.anchorAfter) {
    const following = docText.slice(span.offset + span.length, span.offset + span.length + p.anchorAfter.length)
    if (following !== p.anchorAfter) errs.push('ANCHOR_AFTER_MISMATCH')
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, offset: span.offset, length: span.length }
}

// Anchors are DERIVED from the authoritative document rather than trusted from
// the model: models routinely mis-copy surrounding text, which would otherwise
// reject valid edits. oldText + its exact offset are the safety-critical parts;
// the anchors in the returned proposal are computed here, so they are always true.
export function deriveAnchors(docText, offset, oldTextLen, width = 40) {
  return {
    anchorBefore: docText.slice(Math.max(0, offset - width), offset),
    anchorAfter: docText.slice(offset + oldTextLen, offset + oldTextLen + width),
  }
}

// Structured-output schema passed to Ollama's `format` field. Schema-constrained
// decoding is far more reliable than asking for JSON in prose (measured: the same
// prompt returned fenced/prose JSON without the schema and clean JSON with it).
export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    oldText: { type: 'string' },
    newText: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['oldText', 'newText', 'rationale'],
}

// Prompt the local model for a JSON proposal. Ollama supports format:"json";
// we still validate the shape afterwards and never trust it blindly.
export function buildProposalPrompt({ instruction, docText, filePath, selection }) {
  const context = selection && selection.text
    ? `The user selected this fragment:\n<<<\n${selection.text}\n>>>`
    : 'No selection: operate on the whole active document.'
  return [
    {
      role: 'system',
      content:
        'You are a careful LaTeX editing assistant. Return STRICT JSON only, no prose, ' +
        'with exactly these keys: oldText, newText, rationale. ' +
        'oldText MUST be copied verbatim from the document and occur exactly once; ' +
        'keep it as short as possible while still unique. ' +
        'Keep the edit minimal: preserve \\cite{}, \\ref{}, \\label{}, math environments ' +
        'and bibliography keys exactly. Never delete content the user did not ask to remove. ' +
        'newText replaces oldText.',
    },
    {
      role: 'user',
      content:
        `File: ${filePath}\n${context}\n\nInstruction: ${instruction}\n\n` +
        `Document:\n<<<\n${docText}\n>>>\n\n` +
        'Return the JSON object now.',
    },
  ]
}

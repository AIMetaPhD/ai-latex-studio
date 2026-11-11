// AI sidecar skeleton (G2). Trust model:
//  - Only the CE gateway (same compose network) may call this service, and every
//    request must carry the shared AI_GATEWAY_SECRET header. No browser ever talks
//    to the sidecar directly (it has no published port).
//  - G3 adds: Ollama num_ctx handling, OpenAI BYOK, allowlisted compat endpoint
//    with DNS/SSRF/redirect controls, egress policy. Those are deliberately NOT
//    implemented yet — this file must not be described as a finished provider.
import { createServer } from 'node:http'
import { assertSafeUrl, pinnedRequest } from './ssrf.mjs'
import { validateProposal, buildProposalPrompt, deriveAnchors, extractJsonObject, findSpan, PROPOSAL_SCHEMA, sha256 } from './proposal.mjs'

const PORT = Number(process.env.PORT ?? 8090)
const SECRET = process.env.AI_GATEWAY_SECRET ?? ''
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434'
// Default context window target (plan: default 16384, adjustable per model/RAM).
const NUM_CTX = Number(process.env.AI_NUM_CTX ?? 16384)

// Request bodies are read whole, so they need a ceiling: without one a single
// large POST buffers whatever it is given, and the container has no memory cap.
// 8 MiB is far above any proposal payload (a thesis-sized document is ~1 MiB)
// and far below anything that would hurt. Overridable for unusual setups.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024)

// Distinguishes "the caller sent something unusable" (400/413) from "the
// upstream failed" (502) so each route can answer correctly.
class BodyError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status }
}

function answerBodyError(res, err) {
  if (!(err instanceof BodyError)) return false
  if (!res.headersSent) {
    res.writeHead(err.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.code }))
  } else {
    try { res.end() } catch {}
  }
  return true
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > MAX_BODY_BYTES) throw new BodyError('PAYLOAD_TOO_LARGE', 413)
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}'
  try {
    return JSON.parse(text)
  } catch {
    throw new BodyError('BAD_JSON', 400)
  }
}

// Local provider: Ollama native /api/chat with streaming.
async function handleChat(req, res) {
  const body = await readJson(req)
  const provider = body.provider ?? 'local'
  if (provider === 'openai') return handleOpenAI(req, res, body)
  if (provider === 'compat') return handleCompat(req, res, body)
  if (provider !== 'local') {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'PROVIDER_UNKNOWN', provider }))
  }
  const model = body.model
  if (!model) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'MODEL_REQUIRED' }))
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { num_ctx: body.num_ctx ?? NUM_CTX },
    }),
    signal: AbortSignal.timeout(300000),
  }).catch(err => ({ ok: false, status: 0, err }))

  if (!upstream.ok) {
    res.writeHead(502, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      error: 'OLLAMA_UPSTREAM_FAILED',
      status: upstream.status ?? 0,
      detail: String(upstream.err?.cause?.code ?? upstream.err?.message ?? ''),
    }))
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  // Every stream must end on a terminal event. If the upstream closes without
  // sending `done` (crashed model, proxy cut), the client used to see plain EOF
  // and could not tell "finished" from "truncated". Track it and emit one.
  let sawTerminal = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      // Ollama streams newline-delimited JSON; re-emit text deltas as SSE.
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.error) {
          sawTerminal = true
          res.write(`event: error\ndata: ${JSON.stringify({ error: obj.error })}\n\n`)
          continue
        }
        const delta = obj.message?.content ?? ''
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
        if (obj.done) {
          sawTerminal = true
          res.write(`event: done\ndata: ${JSON.stringify({
            done_reason: obj.done_reason ?? null,
            prompt_eval_count: obj.prompt_eval_count ?? null,
            eval_count: obj.eval_count ?? null,
          })}\n\n`)
        }
      }
    }
  } catch (err) {
    sawTerminal = true
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'STREAM_ABORTED', detail: String(err.message) })}\n\n`)
    } catch { /* client already gone; the response is over either way */ }
  } finally {
    if (!sawTerminal && !res.writableEnded) {
      try {
        res.write(`event: done\ndata: ${JSON.stringify({
          done_reason: 'eof',
          prompt_eval_count: null,
          eval_count: null,
        })}\n\n`)
      } catch { /* ignore: nothing left to tell the client */ }
    }
    res.end()
  }
}

function authorized(req) {
  const h = req.headers['x-ails-gateway-secret']
  if (!SECRET) return false // fail closed if misconfigured
  return typeof h === 'string' && h === SECRET
}

async function json(req, res, handler) {
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
  }
  try {
    const body = await handler(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  } catch (err) {
    if (answerBodyError(res, err)) return
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'UPSTREAM_FAILED', message: String(err?.message ?? err) }))
  }
}

// G4: ask the local model for a structured proposal, then validate it server-side.
// We never apply anything here; the browser applies via CodeMirror after re-check.
async function handleProposal(body) {
  const model = body.model
  const docText = typeof body.docText === 'string' ? body.docText : ''
  const filePath = body.filePath
  if (!model) return { ok: false, error: 'MODEL_REQUIRED' }
  if (!docText) return { ok: false, error: 'DOC_TEXT_REQUIRED' }
  if (body.provider && body.provider !== 'local') {
    // Cloud proposals are allowed but must be explicit; key handling stays server-side.
    return { ok: false, error: 'PROPOSAL_PROVIDER_LOCAL_ONLY_FOR_NOW', provider: body.provider }
  }
  const messages = buildProposalPrompt({
    instruction: String(body.instruction ?? ''),
    docText,
    filePath,
    selection: body.selection,
  })
  // Schema-constrained, low-temperature, retried once: local models still
  // occasionally emit prose. We never "repair" the content — we ask again, and if
  // it still fails the caller gets an explicit error (no silent fabrication).
  let parsed = null
  let lastRaw = ''
  let lastErr = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: attempt === 0 ? messages : [
          ...messages,
          { role: 'user', content: 'Return ONLY a JSON object with keys oldText, newText, rationale. No prose, no code fences.' },
        ],
        stream: false,
        format: PROPOSAL_SCHEMA,
        options: {
          num_ctx: body.num_ctx ?? Math.min(NUM_CTX, 8192),
          temperature: 0.1,
        },
      }),
      signal: AbortSignal.timeout(600000),
    }).catch(err => ({ ok: false, status: 0, err }))

    if (!upstream.ok) {
      lastErr = {
        ok: false,
        error: 'OLLAMA_UPSTREAM_FAILED',
        status: upstream.status ?? 0,
        detail: String(upstream.err?.cause?.code ?? upstream.err?.message ?? ''),
      }
      continue
    }
    const j = await upstream.json()
    lastRaw = j.message?.content ?? ''
    parsed = extractJsonObject(lastRaw)
  }
  if (!parsed) {
    return lastErr ?? { ok: false, error: 'MODEL_JSON_INVALID', raw: String(lastRaw).slice(0, 400) }
  }
  // Locate oldText first (uniqueness is the safety property), then DERIVE both the
  // anchors AND oldText itself from the real document. Using the document's own
  // bytes (not the model's whitespace-normalized copy) keeps the client-side
  // exact-match re-validation honest.
  if (typeof parsed.oldText !== 'string' || !parsed.oldText) {
    return { ok: false, error: 'MODEL_JSON_INVALID', raw: String(lastRaw).slice(0, 400) }
  }
  const span = findSpan(docText, parsed.oldText)
  if (!span) {
    const exact = docText.indexOf(parsed.oldText)
    return { ok: false, error: 'PROPOSAL_INVALID', errors: [exact === -1 ? 'OLD_TEXT_NOT_FOUND' : 'OLD_TEXT_NOT_UNIQUE'] }
  }

  const realOldText = docText.slice(span.offset, span.offset + span.length)
  const anchors = deriveAnchors(docText, span.offset, span.length)
  const proposal = {
    filePath,
    baseDocSha256: sha256(docText),
    oldText: realOldText,
    newText: parsed.newText,
    anchorBefore: anchors.anchorBefore,
    anchorAfter: anchors.anchorAfter,
    rationale: parsed.rationale,
  }
  const check = validateProposal(proposal, docText)
  if (!check.ok) return { ok: false, error: 'PROPOSAL_INVALID', errors: check.errors, proposal }
  return { ok: true, proposal, offset: check.offset }
}

// Cloud provider: OpenAI official API (BYOK). Key comes from server env only.
async function handleOpenAI(req, res, body) {
  const key = process.env.OPENAI_API_KEY ?? ''
  if (!key) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'OPENAI_KEY_NOT_CONFIGURED' }))
  }
  const model = body.model
  if (!model) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'MODEL_REQUIRED' }))
  }
  // NOTE: no path to override the base URL from the browser — fixed official host.
  // redirect:'manual' so a 3xx can never carry our Authorization to another host.
  // (The Fetch spec strips Authorization cross-origin, but we do not rely on that
  // for a key-bearing request.)
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: true,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(300000),
  }).catch(err => ({ err }))

  if (upstream.err) {
    res.writeHead(502, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      error: 'OPENAI_UPSTREAM_FAILED',
      detail: String(upstream.err?.cause?.code ?? upstream.err?.message ?? ''),
    }))
  }
  // Refuse redirects so a 3xx can never carry our Authorization elsewhere.
  // Measured on Node 24: `redirect:'manual'` yields a visible 302 (type=basic,
  // redirected=false). Some runtimes instead surface an opaque redirect with
  // status 0, so both shapes are handled rather than assumed.
  if (upstream.type === 'opaqueredirect' || (upstream.status >= 300 && upstream.status < 400)) {
    res.writeHead(502, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'OPENAI_REDIRECT_REFUSED', status: upstream.status }))
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    res.writeHead(upstream.status || 502, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'OPENAI_UPSTREAM_FAILED', detail: detail.slice(0, 300) }))
  }
  return pipeChatCompletionsSSE(upstream, res)
}

// Admin-allowlisted compatible endpoint. The URL is server-side only
// (COMPAT_BASE_URL); the browser can never supply one. SSRF guards apply.
async function handleCompat(req, res, body) {
  const base = process.env.COMPAT_BASE_URL ?? ''
  if (!base) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'COMPAT_ENDPOINT_NOT_CONFIGURED' }))
  }
  const key = process.env.COMPAT_API_KEY ?? ''
  let safe
  try {
    safe = await assertSafeUrl(base, { allowLoopback: process.env.COMPAT_ALLOW_LOOPBACK === 'true' })
  } catch (err) {
    res.writeHead(403, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'ENDPOINT_REJECTED', reason: err.message }))
  }
  const payload = JSON.stringify({
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: true,
  })
  let upstream
  try {
    upstream = await pinnedRequest({
      ...safe,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: payload,
      // Bounded upstream wait. Without this the admin-configured endpoint could
      // hold a request (and the browser waiting on it) forever; pinnedRequest's
      // own default is 120 s, which is a long time to leave a user guessing.
      // Overridable so an operator can tighten or loosen it, and so the
      // contract test does not have to wait two minutes to prove it fires.
      timeoutMs: Number(process.env.COMPAT_TIMEOUT_MS ?? 120000),
    })
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'COMPAT_UPSTREAM_FAILED', reason: String(err.message) }))
  }
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    res.writeHead(upstream.statusCode, { 'content-type': 'application/json' })
    upstream.resume()
    return res.end(JSON.stringify({ error: 'COMPAT_UPSTREAM_STATUS', status: upstream.statusCode }))
  }
  return pipeChatCompletionsSSE(upstream, res)
}

// OpenAI-style `data: {...}` SSE -> our `data: {delta}` + `event: done` protocol.
async function pipeChatCompletionsSSE(upstream, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const dec = new TextDecoder()
  let buf = ''
  let evalCount = null
  const onChunk = chunk => {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        res.write(`event: done\ndata: ${JSON.stringify({ done_reason: 'stop', eval_count: evalCount })}\n\n`)
        continue
      }
      try {
        const j = JSON.parse(payload)
        const delta = j.choices?.[0]?.delta?.content
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
        if (j.usage?.completion_tokens) evalCount = j.usage.completion_tokens
      } catch { /* ignore malformed keep-alive frames */ }
    }
  }
  try {
    if (typeof upstream.on === 'function') {
      // node IncomingMessage (compat path)
      upstream.on('data', onChunk)
      await new Promise((resolve, reject) => {
        upstream.on('end', resolve)
        upstream.on('error', reject)
      })
    } else {
      // fetch ReadableStream (OpenAI path)
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        onChunk(Buffer.from(value))
      }
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'STREAM_ABORTED' })}\n\n`)
  } finally {
    res.end()
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    // liveness only; returns 200 without exposing env or secrets
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }

  if (req.url === '/v1/models') {
    return json(req, res, async () => {
      const r = await fetch(`${OLLAMA_URL}/api/tags`)
      if (!r.ok) throw new Error(`ollama tags ${r.status}`)
      const j = await r.json()
      return { models: (j.models ?? []).map(m => m.name) }
    })
  }

  if (req.url === '/v1/chat' && req.method === 'POST') {
    // Real local generation (G3): Ollama native /api/chat, streamed through to the
    // browser as SSE. Provider is chosen by the body (`provider` defaults to local).
    // This route streams, so it cannot use the buffering `json()` wrapper -- but it
    // must still enforce the same gateway-secret check the other AI routes get via
    // json(). It previously did not: a fresh-context review found /v1/chat returned
    // MODEL_REQUIRED to an unauthenticated caller while /v1/proposal correctly
    // returned 401. Contained by the unpublished sidecar port + CE gateway auth, but
    // that is defence-in-depth by accident, not by design -- so check it here too.
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
    }
    // This route streams, so it cannot use the buffering json() wrapper -- and
    // that meant a rejected promise here had no handler: a body that was not
    // JSON took the whole sidecar down (measured 2026-11-03: RestartCount 0 -> 1
    // after one malformed POST). Every way out of this handler must end the
    // response instead of the process.
    return handleChat(req, res).catch(err => {
      if (answerBodyError(res, err)) return
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'UPSTREAM_FAILED', message: String(err?.message ?? err) }))
      } else {
        try { res.end() } catch {}
      }
    })
  }

  if (req.url === '/v1/proposal' && req.method === 'POST') {
    return json(req, res, async () => handleProposal(await readJson(req)))
  }

  if (req.url === '/v1/proposal/evaluate' && req.method === 'POST') {
    // Authoritative re-validation at Accept time (browser sends its CURRENT text).
    // requireFreshHash: the server enforces the full-document hash rule, the
    // client-side check is UX only — a tampered browser must not bypass it.
    return json(req, res, async () => {
      const body = await readJson(req)
      const docText = typeof body.currentDocText === 'string' ? body.currentDocText : ''
      const result = validateProposal(body.proposal ?? {}, docText, { requireFreshHash: true })
      return { ...result, currentSha256: sha256(docText) }
    })
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'NOT_FOUND' }))
})

server.listen(PORT, '0.0.0.0', () => {
  // 0.0.0.0 inside the container is fine: no host port is published and the
  // compose network isolates it; requests without the shared secret get 401.
  console.log(`ai-sidecar listening on :${PORT}`)
})

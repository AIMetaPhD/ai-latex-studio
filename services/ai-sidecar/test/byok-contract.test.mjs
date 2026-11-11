// BYOK contract test — the OpenAI-compatible provider path, against a local
// mock upstream. No cloud key, no network beyond loopback, no dependencies.
//
// What this proves: how the sidecar behaves for the four shapes an upstream can
// take (streamed success, auth failure, a stream that dies mid-answer, and an
// upstream that never answers). What it does NOT prove: that the real cloud
// endpoint behaves the same. Mock passing is not cloud E2E; that stays
// NOT_TESTED until a real key is authorised.
//
// The compatible endpoint is the right target here: it is the provider that
// takes a server-side base URL, so a mock can stand in for it without the
// sidecar growing a test-only switch on the OpenAI host.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'src', 'server.mjs')
const SECRET = 'test-gateway-secret'
const KEY = 'test-compat-key'

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

async function startSidecar(compatUrl, extraEnv = {}) {
  const port = 18000 + Math.floor(Math.random() * 5000)
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      AI_GATEWAY_SECRET: SECRET,
      COMPAT_BASE_URL: compatUrl,
      COMPAT_API_KEY: KEY,
      COMPAT_ALLOW_LOOPBACK: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar did not start')), 10000)
    child.stdout.on('data', d => {
      if (String(d).includes('listening')) { clearTimeout(timer); resolve() }
    })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`sidecar exited ${code}`)) })
  })
  return { child, base: `http://127.0.0.1:${port}` }
}

async function chat(base, body) {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ails-gateway-secret': SECRET },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

const ASK = { provider: 'compat', model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }

test('streamed answer is relayed chunk by chunk and ends with done', async () => {
  const mock = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`, 'sidecar must send the key it holds')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const mockPort = await listen(mock)
  const { child, base } = await startSidecar(`http://127.0.0.1:${mockPort}/v1/chat/completions`)
  try {
    const out = await chat(base, ASK)
    assert.equal(out.status, 200)
    assert.match(out.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.match(out.text, /Hello/)
    assert.match(out.text, /world/)
    assert.match(out.text, /event: done/)
  } finally {
    child.kill()
    mock.close()
  }
})

test('a rejected key is a clean 401, not a hang and not a fake stream', async () => {
  const mock = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
  })
  const mockPort = await listen(mock)
  const { child, base } = await startSidecar(`http://127.0.0.1:${mockPort}/v1/chat/completions`)
  try {
    const out = await chat(base, ASK)
    assert.equal(out.status, 401)
    assert.match(out.text, /COMPAT_UPSTREAM_STATUS/)
    assert.equal(out.headers.get('content-type'), 'application/json')
  } finally {
    child.kill()
    mock.close()
  }
})

test('a stream that dies mid-answer surfaces as an error event, not as success', async () => {
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    // Kill the connection the way a dropped upstream would.
    setTimeout(() => res.destroy(), 50)
  })
  const mockPort = await listen(mock)
  const { child, base } = await startSidecar(`http://127.0.0.1:${mockPort}/v1/chat/completions`)
  try {
    const out = await chat(base, ASK)
    assert.equal(out.status, 200, 'headers were already sent; the failure must be in-band')
    assert.match(out.text, /partial/)
    assert.match(out.text, /event: error/)
    assert.match(out.text, /STREAM_ABORTED/)
    assert.doesNotMatch(out.text, /event: done/, 'a broken stream must not look completed')
  } finally {
    child.kill()
    mock.close()
  }
})

test('an upstream that never answers is cut off by the configured timeout', async () => {
  const held = []
  const mock = http.createServer((req, res) => { held.push(res) }) // accept, never respond
  const mockPort = await listen(mock)
  const { child, base } = await startSidecar(
    `http://127.0.0.1:${mockPort}/v1/chat/completions`,
    { COMPAT_TIMEOUT_MS: '400' }
  )
  try {
    const started = Date.now()
    const out = await chat(base, ASK)
    const elapsed = Date.now() - started
    assert.equal(out.status, 502)
    assert.match(out.text, /COMPAT_UPSTREAM_FAILED/)
    assert.ok(elapsed < 5000, `should give up quickly, took ${elapsed} ms`)
  } finally {
    child.kill()
    for (const r of held) r.destroy()
    mock.close()
  }
})

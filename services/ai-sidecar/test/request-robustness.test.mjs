// A malformed request must cost one response, not the service.
//
// Measured on the running sidecar on 2026-11-03: one POST of invalid JSON to
// /v1/chat took the process down (RestartCount 0 -> 1). The route streams, so it
// could not use the buffering json() wrapper, and the promise it returned had no
// catch. The body reader was also unbounded, in a container with no memory cap.
//
// These tests are the regression: bad JSON is a 400, a too-large body is a 413,
// and after both the server still answers. Zero dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'src', 'server.mjs')
const SECRET = 'test-jwqxvb-mfqpzc'

async function start(extraEnv = {}) {
  const port = 18000 + Math.floor(Math.random() * 5000)
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), AI_GATEWAY_SECRET: SECRET, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar did not start')), 10000)
    child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`sidecar exited ${code}`)) })
  })
  return { child, base: `http://127.0.0.1:${port}` }
}

const post = (base, body, raw = false) => fetch(`${base}/v1/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ails-gateway-secret': SECRET },
  body: raw ? body : JSON.stringify(body),
})

test('invalid JSON on the streaming route is a 400 and the process survives', async () => {
  const { child, base } = await start()
  try {
    const bad = await post(base, '{not json', true)
    assert.equal(bad.status, 400)
    const body = await bad.json()
    assert.equal(body.error, 'BAD_JSON')

    // The point of the test: the next request is answered, not refused at the
    // socket, which is what a crashed-and-restarting process looks like.
    const after = await post(base, { provider: 'local', model: 'x', messages: [] })
    assert.ok(after.status >= 400 && after.status < 600, `got ${after.status}`)
  } finally {
    child.kill()
  }
})

test('invalid JSON on a buffered route is a 400, not an upstream failure', async () => {
  const { child, base } = await start()
  try {
    const res = await fetch(`${base}/v1/proposal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ails-gateway-secret': SECRET },
      body: '{{{',
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'BAD_JSON')
  } finally {
    child.kill()
  }
})

test('a body over the configured ceiling is refused with 413', async () => {
  const { child, base } = await start({ MAX_BODY_BYTES: '1024' })
  try {
    const big = JSON.stringify({ provider: 'local', padding: 'x'.repeat(4096) })
    const res = await post(base, big, true)
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'PAYLOAD_TOO_LARGE')

    const after = await post(base, { provider: 'local', model: 'x', messages: [] })
    assert.ok(after.status >= 400 && after.status < 600, `got ${after.status}`)
  } finally {
    child.kill()
  }
})

test('a body under the ceiling is still accepted', async () => {
  const { child, base } = await start({ MAX_BODY_BYTES: '1024' })
  try {
    const res = await post(base, { provider: 'local', model: 'x', messages: [] })
    // Not 400/413: the request reached the provider path and failed upstream,
    // which is the expected outcome with no Ollama here.
    assert.ok(![400, 413].includes(res.status), `unexpected ${res.status}`)
  } finally {
    child.kill()
  }
})

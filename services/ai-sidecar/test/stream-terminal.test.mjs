// Every chat stream must end on a terminal SSE event.
//
// Before this, handleChat broke out of the read loop on upstream EOF and called
// res.end() without a terminal event. When a model or proxy closed the stream
// without sending `done`, the browser saw plain EOF and could not tell "finished"
// from "truncated". The client now always gets exactly one terminal event.
//
// Zero dependencies: a local mock Ollama, the real sidecar as a child process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'src', 'server.mjs')
const SECRET = 'test-terminal-7q2m'

// A stand-in Ollama: streams two NDJSON deltas, then optionally a `done` line.
function mockOllama({ sendDone }) {
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(404); return res.end() }
      req.resume()
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { content: 'hello ' } }) + '\n')
      res.write(JSON.stringify({ message: { content: 'world' } }) + '\n')
      if (sendDone) {
        res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 5 }) + '\n')
      }
      res.end()
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

async function startSidecar(ollamaUrl) {
  const port = 18500 + Math.floor(Math.random() * 4000)
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), AI_GATEWAY_SECRET: SECRET, OLLAMA_URL: ollamaUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar did not start')), 10000)
    child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(timer); resolve() } })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`sidecar exited ${code}`)) })
  })
  return { child, base: `http://127.0.0.1:${port}` }
}

async function chat(base) {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ails-gateway-secret': SECRET },
    body: JSON.stringify({ provider: 'local', model: 'mock', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  return await res.text()
}

test('upstream EOF without done still ends with a terminal done(eof)', async () => {
  const { srv, port } = await mockOllama({ sendDone: false })
  const { child, base } = await startSidecar(`http://127.0.0.1:${port}`)
  try {
    const body = await chat(base)
    assert.match(body, /hello /)
    assert.match(body, /"done_reason":"eof"/)
    assert.equal((body.match(/event: done/g) || []).length, 1, 'exactly one terminal event')
  } finally {
    child.kill()
    srv.close()
  }
})

test('upstream done is passed through and not duplicated by the eof fallback', async () => {
  const { srv, port } = await mockOllama({ sendDone: true })
  const { child, base } = await startSidecar(`http://127.0.0.1:${port}`)
  try {
    const body = await chat(base)
    assert.match(body, /"done_reason":"stop"/)
    assert.doesNotMatch(body, /"done_reason":"eof"/)
    assert.equal((body.match(/event: done/g) || []).length, 1)
  } finally {
    child.kill()
    srv.close()
  }
})

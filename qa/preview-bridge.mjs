// Preview bridge: a local HTTP + WebSocket reverse proxy to the Docker-served UI.
//
// Why this exists: this project's UI is Overleaf CE running in Docker on
// 127.0.0.1:8081. The preview launcher wants a command that serves a port, and it
// could not take 8081 (Docker holds it), so it assigns another port. This process
// binds that assigned port and forwards everything to the real stack -- including
// the WebSocket upgrade, without which Overleaf's editor would never sync.
//
// It adds no behaviour of its own: no rewriting, no auth bypass, no caching. If the
// real stack is down it says so and exits non-zero rather than serving a stub.
import http from 'node:http'
import net from 'node:net'

const TARGET = new URL(process.env.AILS_PREVIEW_TARGET ?? 'http://127.0.0.1:8081')
const LISTEN_PORT = Number(process.env.PORT ?? process.argv[2] ?? 8083)
const LISTEN_HOST = '127.0.0.1'

async function targetIsUp() {
  try {
    const res = await fetch(new URL('/login', TARGET), { signal: AbortSignal.timeout(5000) })
    return res.status === 200
  } catch {
    return false
  }
}

if (!(await targetIsUp())) {
  console.error(
    `[preview-bridge] ${TARGET.origin} is not answering. Start the stack first:\n` +
    `[preview-bridge]   bash scripts/up.sh\n` +
    `[preview-bridge] refusing to serve a stub in its place.`
  )
  process.exit(2)
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: TARGET.hostname,
      port: TARGET.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: TARGET.host },
    },
    up => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    }
  )
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`preview-bridge upstream error: ${err.message}`)
  })
  req.pipe(upstream)
})

// WebSocket / other upgrades: raw TCP passthrough once headers are replayed.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(Number(TARGET.port || 80), TARGET.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`)
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[preview-bridge] ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET.origin} (http + ws)`)
})

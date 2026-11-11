// Ollama bridge for hosts where host.docker.internal does NOT reach the host
// Ollama (native Linux / WSL Docker Engine). Runs with network_mode: host, so it
// shares the host netns: it binds the docker bridge gateway address and forwards
// to the host loopback. Ollama itself stays off the LAN.
//
//   BRIDGE_BIND     (default 172.17.0.1) docker0 gateway as seen by containers
//   BRIDGE_PORT     (default 11435)
//   OLLAMA_UPSTREAM (default 127.0.0.1:11434)
//
// This is an unauthenticated TCP pipe (Ollama's API has no auth), so the bind
// address is the only thing containing it. A reviewer correctly noted that
// honouring BRIDGE_BIND verbatim would let one env var (0.0.0.0) turn "private
// bridge only" into "exposed to the LAN", contradicting this file's own comment,
// and that split(':') mis-parses an IPv6 upstream. Both are fixed here, minimally:
// the bind is refused unless loopback/private (or an explicit override), and the
// host:port split tolerates IPv6.
import net from 'node:net'

const BIND = process.env.BRIDGE_BIND ?? '172.17.0.1'
const PORT = Number(process.env.BRIDGE_PORT ?? 11435)
const OVERRIDE = process.env.BRIDGE_ALLOW_PUBLIC_BIND === 'true'

function isPrivateOrLoopback(ip) {
  if (ip === 'localhost' || ip === '::1') return true
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a === 169 || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase()
    return s.startsWith('::ffff:7f') || s.startsWith('::ffff:127') ||
      s.startsWith('fe80') || s.startsWith('fd') || s.startsWith('fc')
  }
  return false
}

if (!isPrivateOrLoopback(BIND) || BIND === '0.0.0.0' || BIND === '::') {
  if (!OVERRIDE) {
    console.error(
      `[ollama-bridge] refusing to bind '${BIND}': that publishes an unauthenticated pipe to the ` +
      `host Ollama on every interface. Set BRIDGE_ALLOW_PUBLIC_BIND=true only if you deliberately ` +
      `firewall/route-restrict this host.`
    )
    process.exit(1)
  }
  console.warn(`[ollama-bridge] WARNING: binding '${BIND}' per explicit override -- exposed surface.`)
}

// host:port split tolerating a bracketed IPv6 host.
function splitUpstream(raw) {
  const s = (raw || '127.0.0.1:11434').trim()
  if (s.startsWith('[')) {
    const c = s.indexOf(']')
    if (c === -1 || s[c + 1] !== ':') return null
    return [s.slice(1, c), s.slice(c + 2)]
  }
  const i = s.indexOf(':')
  if (i === -1 || i !== s.lastIndexOf(':')) return null // bare IPv6 is ambiguous -> reject
  return [s.slice(0, i), s.slice(i + 1)]
}

const up = splitUpstream(process.env.OLLAMA_UPSTREAM)
if (!up || !Number.isInteger(Number(up[1])) || Number(up[1]) < 1 || Number(up[1]) > 65535) {
  console.error(`[ollama-bridge] bad OLLAMA_UPSTREAM '${process.env.OLLAMA_UPSTREAM ?? ''}' (use host:port or [::1]:port)`)
  process.exit(1)
}
const [UP_HOST, UP_PORT] = up

const server = net.createServer(client => {
  const upstream = net.connect(Number(UP_PORT), UP_HOST)
  client.pipe(upstream).pipe(client)
  const kill = () => { client.destroy(); upstream.destroy() }
  client.on('error', kill); upstream.on('error', kill)
  client.on('close', kill); upstream.on('close', kill)
})

server.on('error', err => {
  console.error(`[ollama-bridge] listen ${BIND}:${PORT} failed: ${err.code ?? err.message}`)
  process.exit(1)
})

server.listen(PORT, BIND, () => {
  console.log(`[ollama-bridge] listening on ${BIND}:${PORT} -> ${UP_HOST}:${UP_PORT}`)
})

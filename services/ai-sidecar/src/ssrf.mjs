// SSRF / DNS-rebinding guard for the admin-allowlisted compatible endpoint (B-08).
//
// Enforcement happens at CONNECT time, not parse time:
//  * https: required (http: only for an explicitly allowlisted loopback dev URL)
//  * hostname must resolve to public unicast; private/loopback/link-local/CGNAT/
//    multicast/reserved/metadata ranges are denied
//  * the validated IP is PINNED via the request `lookup` hook, so a second DNS
//    answer cannot redirect the connection (DNS rebinding)
//  * redirects are never followed; any 3xx is an error
//
// Dependency-free (node:https + node:dns) so the whole guard is auditable and the
// sidecar stays a zero-dependency image.
import dns from 'node:dns'
import net from 'node:net'
import https from 'node:https'
import http from 'node:http'

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]

const v4ToInt = ip => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0

export function isPrivateV4(ip) {
  const n = v4ToInt(ip)
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (v4ToInt(base) & mask)
  })
}

// Expand an IPv6 string to 16 bytes (handles `::` compression and embedded
// IPv4 tails). Returns null for malformed input so callers fail closed.
export function v6ToBytes(ip) {
  let s = String(ip).trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  if (!s || s.length > 45) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = str => {
    if (!str) return []
    const parts = str.split(':')
    const out = []
    for (const p of parts) {
      if (p.includes('.')) {
        // embedded IPv4 (e.g. ::ffff:127.0.0.1) contributes two groups
        if (!net.isIPv4(p)) return null
        const n = v4ToInt(p)
        out.push((n >>> 16) & 0xffff, n & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null
      out.push(parseInt(p, 16))
    }
    return out
  }
  const head = groups(halves[0])
  if (head === null) return null
  let gs
  if (halves.length === 2) {
    const tail = groups(halves[1])
    if (tail === null) return null
    const need = 8 - head.length - tail.length
    if (need < 1) return null
    gs = [...head, ...Array(need).fill(0), ...tail]
  } else {
    gs = head
    if (gs.length !== 8) return null
  }
  const b = new Uint8Array(16)
  gs.forEach((g, i) => { b[i * 2] = g >>> 8; b[i * 2 + 1] = g & 0xff })
  return b
}

const inPrefix = (bytes, base, bits) => {
  for (let i = 0; i < 16; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8))
    if (keep === 0) return true
    const mask = (0xff << (8 - keep)) & 0xff
    if ((bytes[i] & mask) !== (base[i] & mask)) return false
  }
  return true
}

const v6Prefix = (...groups16) => {
  const b = new Uint8Array(16)
  groups16.forEach((g, i) => { b[i * 2] = g >>> 8; b[i * 2 + 1] = g & 0xff })
  return b
}

// IPv6 ranges that must never be reachable from the sidecar, including the
// transition mechanisms that EMBED an IPv4 address inside the v6 literal —
// string-prefix checks miss these (found by independent review, 2026-10-29).
const PRIVATE_V6 = [
  ['unspecified', v6Prefix(0, 0, 0, 0, 0, 0, 0, 0), 128],
  ['loopback', v6Prefix(0, 0, 0, 0, 0, 0, 0, 1), 128],
  ['unique-local fc00::/7', v6Prefix(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7],
  ['site-local (deprecated) fec0::/10', v6Prefix(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10],
  ['link-local fe80::/10', v6Prefix(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10],
  ['multicast ff00::/8', v6Prefix(0xff00, 0, 0, 0, 0, 0, 0, 0), 8],
  ['discard-only 100::/64', v6Prefix(0x0100, 0, 0, 0, 0, 0, 0, 0), 64],
]

const bytesToV4 = b => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`

// IPv4 addresses hidden inside an IPv6 literal by any of the transition
// mechanisms. Each one is checked against the IPv4 rules as well.
export function embeddedV4(bytes) {
  const out = []
  // ::ffff:0:0/96 (v4-mapped) and ::/96 (v4-compatible, deprecated)
  if (inPrefix(bytes, v6Prefix(0, 0, 0, 0, 0, 0xffff, 0, 0), 96) ||
      inPrefix(bytes, v6Prefix(0, 0, 0, 0, 0, 0, 0, 0), 96)) {
    out.push(bytesToV4(bytes.subarray(12, 16)))
  }
  // NAT64 well-known prefix 64:ff9b::/96 (and the /48 discovery form)
  if (inPrefix(bytes, v6Prefix(0x0064, 0xff9b, 0, 0, 0, 0, 0, 0), 96)) {
    out.push(bytesToV4(bytes.subarray(12, 16)))
  }
  // 6to4 2002::/16 carries the v4 address in bytes 2..5
  if (inPrefix(bytes, v6Prefix(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)) {
    out.push(bytesToV4(bytes.subarray(2, 6)))
  }
  // Teredo 2001:0000::/32 carries the obfuscated v4 in bytes 12..15
  if (inPrefix(bytes, v6Prefix(0x2001, 0, 0, 0, 0, 0, 0, 0), 32)) {
    out.push(bytesToV4(new Uint8Array([
      0xff ^ bytes[12], 0xff ^ bytes[13], 0xff ^ bytes[14], 0xff ^ bytes[15],
    ])))
  }
  return out
}

export function isPrivateV6(ip) {
  const bytes = v6ToBytes(ip)
  if (!bytes) return true // malformed -> deny
  for (const [, base, bits] of PRIVATE_V6) if (inPrefix(bytes, base, bits)) return true
  for (const v4 of embeddedV4(bytes)) if (isPrivateV4(v4)) return true
  return false
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (net.isIPv6(ip)) return isPrivateV6(ip)
  return true
}

export async function assertSafeUrl(rawUrl, { allowLoopback = false } = {}) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('INVALID_URL') }
  if (!/^https?:$/.test(u.protocol)) throw new Error('SCHEME_DENIED')
  if (u.username || u.password) throw new Error('CREDENTIALS_IN_URL_DENIED')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const loopbackName = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (u.protocol === 'http:' && !(allowLoopback && loopbackName)) {
    throw new Error('HTTP_ONLY_FOR_ALLOWLISTED_LOOPBACK')
  }
  let ip
  if (net.isIP(host)) {
    if (isPrivateIp(host) && !(allowLoopback && loopbackName)) throw new Error('PRIVATE_ADDRESS_DENIED')
    ip = host
  } else {
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true })
    if (!addrs.length) throw new Error('DNS_NO_RESULT')
    for (const a of addrs) {
      if (isPrivateIp(a.address) && !(allowLoopback && loopbackName)) throw new Error('PRIVATE_ADDRESS_DENIED')
    }
    ip = addrs[0].address
  }
  return { url: u, ip, family: net.isIPv6(ip) ? 6 : 4 }
}

// Perform the request with the validated IP pinned in the socket lookup.
export function pinnedRequest({ url, ip, family, method = 'POST', headers = {}, body = '', timeoutMs = 120000 }) {
  const mod = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      // pin: every connection in this request resolves to the validated address
      lookup: (hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: ip, family }])
        return cb(null, ip, family)
      },
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume()
        reject(new Error('REDIRECT_DENIED'))
        return
      }
      resolve(res)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('UPSTREAM_TIMEOUT')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

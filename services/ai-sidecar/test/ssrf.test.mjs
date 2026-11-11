// Unit tests for the SSRF/DNS-rebinding guard (no network needed for the denials).
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIp, assertSafeUrl } from '../src/ssrf.mjs'

test('private and reserved IPv4 are denied', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',      // CGNAT
    '0.0.0.0', '224.0.0.1', '255.255.255.255',
  ]) assert.equal(isPrivateIp(ip), true, ip)
})

test('public IPv4 passes', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('loopback and link-local IPv6 are denied', () => {
  for (const ip of ['::1', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
})

// Expanded/compressed forms and IPv4-embedding transition mechanisms. The
// original string-prefix implementation classified every one of these as
// public; found by independent review (an independent reviewer, 2026-10-29) and confirmed.
test('IPv6 bypass forms are denied (expanded, 6to4, NAT64, Teredo)', () => {
  for (const ip of [
    '0:0:0:0:0:0:0:1',                        // expanded ::1
    '0:0:0:0:0:0:0:0',                        // expanded ::
    'fe80:0000:0000:0000:0000:0000:0000:0001', // expanded link-local
    'fec0::1',                                 // old site-local (inside fc00::/7)
    'ff02::1',                                 // multicast
    '100::1',                                  // discard-only
    '::ffff:7f00:0001',                        // v4-mapped, hex form of 127.0.0.1
    '2002:7f00:0001::',                        // 6to4 wrapping 127.0.0.1
    '2002:c0a8:0101::',                        // 6to4 wrapping 192.168.1.1
    '64:ff9b::127.0.0.1',                      // NAT64 wrapping loopback
    '64:ff9b::c0a8:101',                       // NAT64 wrapping 192.168.1.1
    '2001:0000:4136:e378:8000:63bf:33f:f2a5', // Teredo -> 192.0.2.1 (test-net)
  ]) {
    assert.equal(isPrivateIp(ip), true, `should deny: ${ip}`)
  }
})

test('genuine public IPv6 still passes (no over-blocking)', () => {
  for (const ip of [
    '2001:4860:4860::8888', // Google DNS
    '2606:4700:4700::1111', // Cloudflare
    '::ffff:8.8.8.8',        // v4-mapped public
    '64:ff9b::8.8.8.8',      // NAT64 of a public v4
    '2002:0808:0808::',      // 6to4 of 8.8.8.8
  ]) {
    assert.equal(isPrivateIp(ip), false, `should allow: ${ip}`)
  }
})

test('malformed IPv6 fails closed', () => {
  for (const ip of ['fe8x::1', ':::', '12345::', ':::1', '']) {
    assert.equal(isPrivateIp(ip), true, `should deny malformed: ${ip}`)
  }
})

test('http is rejected unless loopback is explicitly allowed', async () => {
  await assert.rejects(() => assertSafeUrl('http://example.com/x'), /HTTP_ONLY_FOR_ALLOWLISTED_LOOPBACK/)
  await assert.rejects(() => assertSafeUrl('ftp://example.com/x'), /SCHEME_DENIED|HTTP_ONLY/)
})

test('credentials in URL are rejected', async () => {
  await assert.rejects(() => assertSafeUrl('https://user:pass@example.com/'), /CREDENTIALS_IN_URL_DENIED/)
})

test('literal private IP URL is rejected', async () => {
  await assert.rejects(() => assertSafeUrl('https://127.0.0.1/v1'), /PRIVATE_ADDRESS_DENIED/)
  await assert.rejects(() => assertSafeUrl('https://169.254.169.254/latest/meta-data/'), /PRIVATE_ADDRESS_DENIED/)
})

test('private IP is rejected even when allowLoopback (only loopback names pass)', async () => {
  await assert.rejects(() => assertSafeUrl('https://192.168.0.10/x', { allowLoopback: true }), /PRIVATE_ADDRESS_DENIED/)
})

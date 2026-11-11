// G1 probe: same-origin /api/ai gateway guarded by real CE session + CSRF.
// Cases: anonymous GET/POST, logged-in GET, logged-in POST with and without token.
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from './lib.mjs'

const report = { startedAt: new Date().toISOString(), base: BASE, cases: [] }
const caseOf = name => report.cases.find(c => c.name === name) ?? {}
const record = (name, data) => {
  report.cases.push({ name, at: new Date().toISOString(), ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 300)}`)
}

ensureArtifacts()
const browser = await launch()

// --- 1. Anonymous context: no session cookie ---
{
  const { context, page } = await newPage(browser)
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const anonGet = await page.evaluate(async () => {
    const r = await fetch('/api/ai/health', { headers: { accept: 'application/json' } })
    return { status: r.status, ct: r.headers.get('content-type'), body: (await r.text()).slice(0, 120) }
  })
  record('anon-get', anonGet)
  const anonPost = await page.evaluate(async () => {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
    })
    return { status: r.status, body: (await r.text()).slice(0, 120) }
  })
  record('anon-post', anonPost)
  await context.close()
}

// --- 2. Authenticated context ---
{
  const { context, page } = await newPage(browser, { traceName: '05-gateway' })
  await login(page)
  const csrfToken = await page.evaluate(
    () => document.querySelector('meta[name="ol-csrfToken"]')?.content ?? null
  )
  record('csrf-token-present', { csrfToken: csrfToken ? csrfToken.slice(0, 8) + '…' : null })

  const authGet = await page.evaluate(async () => {
    const r = await fetch('/api/ai/health', { headers: { accept: 'application/json' } })
    return { status: r.status, body: await r.text() }
  })
  record('auth-get', authGet)

  const postNoToken = await page.evaluate(async () => {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    return { status: r.status, body: (await r.text()).slice(0, 200) }
  })
  record('auth-post-no-csrf', postNoToken)

  const postWithToken = await page.evaluate(async token => {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': token,
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    return { status: r.status, body: (await r.text()).slice(0, 200) }
  }, csrfToken)
  record('auth-post-with-csrf', postWithToken)

  const cspHeader = await page.evaluate(async () => {
    const r = await fetch(`${location.origin}/project`, { headers: { accept: 'text/html' } })
    return r.headers.get('content-security-policy')
  })
  record('csp-still-set', { csp: cspHeader?.slice(0, 160) ?? null })

  // This probe tests the GATEWAY AUTH BOUNDARY, not chat functionality. The body
  // sent below ({hello:'world'}) is deliberately minimal, so the sidecar's body
  // validator answers 400 MODEL_REQUIRED -- which means the request DID pass the
  // gateway auth + CSRF gate and reached the sidecar (a 401 would mean the shared
  // x-ails-gateway-secret was not forwarded). Asserting ===200 was stale from
  // before /v1/chat validated its body, and it misreported a healthy gateway as a
  // failure. What matters: not 401/403.
  const withCsrfStatus = caseOf('auth-post-with-csrf').status
  const passedAuthGate = ![401, 403].includes(withCsrfStatus)
  report.passed =
    caseOf('anon-get').status !== 200 &&
    caseOf('anon-post').status !== 200 &&
    caseOf('auth-get').status === 200 &&
    caseOf('auth-post-no-csrf').status === 403 &&
    passedAuthGate &&
    !!caseOf('csp-still-set').csp
  report.tracePath = await saveTrace(context, '05-gateway')
  await context.close()
}

fs.writeFileSync(path.join(ARTIFACTS, '05-gateway.json'), JSON.stringify(report, null, 2))
await browser.close()
console.log(report.passed ? 'PASS 05-gateway-auth' : 'FAIL 05-gateway-auth')

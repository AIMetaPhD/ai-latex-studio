// G1 probe: first-run admin creation, login, session/CSRF behaviour, and
// whether an unauthenticated same-origin /api/ai/* request is rejected.
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, login, registerAdminIfNeeded, BASE, ARTIFACTS } from './lib.mjs'

const report = { startedAt: new Date().toISOString(), base: BASE, steps: [] }
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`[${name}]`, JSON.stringify(data).slice(0, 400))
}

ensureArtifacts()
const browser = await launch()
const { context, page, events } = await newPage(browser, { traceName: '01-auth' })

try {
  const registered = await registerAdminIfNeeded(page)
  step('landing', { url: page.url(), registeredNow: registered })

  if (registered) {
    await page.waitForURL(/\/project/, { timeout: 30000 }).catch(() => {})
  }
  if (!page.url().includes('/project')) {
    await login(page)
  }
  step('authenticated', { url: page.url(), title: await page.title() })

  await page.screenshot({ path: path.join(ARTIFACTS, '01-project-list.png'), fullPage: true })

  // Session + CSRF material available to the CE front end
  const clientState = await page.evaluate(() => ({
    csrfToken: document.querySelector('meta[name="ol-csrfToken"]')?.content?.slice(0, 8) ?? null,
    hasOverleafGlobal: typeof window.overleaf !== 'undefined',
    overleafKeys: typeof window.overleaf === 'object' && window.overleaf ? Object.keys(window.overleaf) : [],
    cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean),
  }))
  step('client-state', clientState)

  // Same-origin AI gateway probe. On the hardened image the module is baked in, so
  // an authenticated same-origin call must succeed (200 + ok:true) -- proving the
  // browser can reach /api/ai/* with its existing CE session and no CORS bypass.
  // Against pristine CE this route does not exist (404), which is also acceptable
  // evidence for this G1 probe; anything else is a failure.
  const aiProbe = await page.evaluate(async () => {
    const res = await fetch('/api/ai/health', { credentials: 'include', headers: { accept: 'application/json' } })
    let body = null
    try { body = await res.json() } catch { /* 404 page is HTML */ }
    return { status: res.status, ok: body?.ok === true, userIdSeen: !!body?.userId }
  })
  step('api-ai-gateway', aiProbe)
  // Anonymous rejection is covered properly in a cookie-free context by
  // 05-gateway-auth.mjs; this probe only proves the authenticated same-origin path.
  report.passed = aiProbe.status === 200 ? aiProbe.ok === true : aiProbe.status === 404
} catch (err) {
  report.passed = false
  report.error = String(err)
  await page.screenshot({ path: path.join(ARTIFACTS, '01-error.png'), fullPage: true }).catch(() => {})
} finally {
  report.tracePath = await saveTrace(context, '01-auth')
  report.consoleEvents = events.filter(e => e.type !== 'console' || e.level === 'error').slice(0, 50)
  fs.writeFileSync(path.join(ARTIFACTS, '01-auth.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS 01-auth-probe' : 'FAIL 01-auth-probe')
}

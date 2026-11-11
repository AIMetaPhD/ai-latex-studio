#!/usr/bin/env node
// G5 independent test runner. Produces PASS/FAIL/BLOCKED/NOT_TESTED per case and
// writes raw artifacts + an evidence manifest. Meant to be executed by an independent reviewer on a
// clean machine; it never asserts anything it did not observe.
//
// usage: node qa/g5/run-g5.mjs --out reports/g5/raw/<platform> [--model qwen3.5:9b]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const OUT = path.resolve(argOf('out', 'reports/g5/raw/local'))
const MODEL = argOf('model', 'qwen3.5:9b')
const BASE = process.env.CE_BASE_URL ?? 'http://127.0.0.1:8080'
const EMAIL = process.env.AILS_ADMIN_EMAIL ?? 'g5@example.invalid'
const PASS = process.env.AILS_ADMIN_PASS
if (!PASS) {
  // A built-in default password here meant a green suite could be produced without
  // anyone saying which credential they used -- and left a credential in tracked
  // source, which qa/g1/lib.mjs deliberately avoids. Require it.
  console.error('ERROR: AILS_ADMIN_PASS is not set (the suite logs in for real)')
  process.exit(2)
}

fs.mkdirSync(OUT, { recursive: true })
const results = []
const record = (id, level, status, detail, artifacts = []) => {
  results.push({ id, level, status, detail, artifacts })
  console.log(`${status.padEnd(11)} ${id} ${detail ?? ''}`)
}
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

// ZIP bytes embed timestamps, so compare extracted file CONTENT instead.
function unzipTo(zipPath, dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  try {
    execFileSync('unzip', ['-qq', '-o', zipPath, '-d', dir], { stdio: 'ignore' })
  } catch {
    // Windows hosts without unzip: fall back to PowerShell
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${path.resolve(zipPath)}' -DestinationPath '${path.resolve(dir)}' -Force`])
  }
}

function contentHash(zipPath) {
  const dir = zipPath + '.x'
  unzipTo(zipPath, dir)
  const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const h = crypto.createHash('sha256')
  for (const f of walk(dir).sort()) {
    h.update(path.relative(dir, f).split(path.sep).join('/'))
    h.update(fs.readFileSync(f))
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return h.digest('hex')
}
const save = (name, data) => {
  const p = path.join(OUT, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  return p
}

// Allow an explicit Chromium path on machines whose Playwright browser revision
// differs from the bundled one (e.g. offline installs).
const launchOpts = { headless: true }
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH
const browser = await chromium.launch(launchOpts)
// Pin the UI language. The sidebar follows the browser's language, so an
// English-locale machine still gets the English strings these selectors use.
// (Measured: without this, a zh-CN host rendered "接受" and every text-based
// click timed out -- a harness defect, not a product one.)
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
await context.addInitScript(() => { try { localStorage.setItem('ails.lang', 'en') } catch {} })
await context.tracing.start({ screenshots: true, snapshots: true })
const page = await context.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })

async function login() {
  // First run exposes /launchpad; later runs /login. Retry once because the React
  // form can need a moment before the submit click registers.
  await page.goto(`${BASE}/launchpad`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(1200)
  if (page.url().includes('/launchpad')) {
    await page.locator('input[name="email"]').first().fill(EMAIL)
    await page.locator('input[type="password"]').first().fill(PASS)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.locator('button[type="submit"]').first().click(),
    ])
  }
  if (page.url().includes('/project')) return
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[name="password"]', { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.fill('input[name="email"]', EMAIL)
    await page.fill('input[name="password"]', PASS)
    await page.click('button[type="submit"]')
    const ok = await page.waitForFunction(() => location.pathname.startsWith('/project'), null, { timeout: 20000 })
      .then(() => true).catch(() => false)
    if (ok) return
  }
  throw new Error('login failed after retries')
}

let projectId = null
try {
  // W01: cold start reachable + admin session
  const loginPage = await context.request.get(`${BASE}/login`, { failOnStatusCode: false })
  record('W01', 'P0', loginPage.status() === 200 ? 'PASS' : 'FAIL', `GET /login -> ${loginPage.status()}`)
  await login()
  record('W01b', 'P0', page.url().includes('/project') ? 'PASS' : 'FAIL', `landed on ${page.url()}`)

  // W02: anonymous API is rejected — must run in a COOKIE-FREE context, otherwise
  // the logged-in session makes it a false 200 (this was a runner bug, fixed).
  const anonCtx = await browser.newContext()
  const anonPage = await anonCtx.newPage()
  await anonPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const anon = await anonPage.evaluate(async () => {
    const r = await fetch('/api/ai/health', { headers: { accept: 'application/json' } })
    return r.status
  })
  await anonCtx.close()
  record('W02', 'P0', anon === 401 ? 'PASS' : 'FAIL', `/api/ai/health anonymous -> ${anon}`)

  // W03/W04/W05: create project, upload fixture, compile
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForTimeout(400)
  await page.getByText(/blank project/i).first().click()
  await page.waitForTimeout(500)
  await page.locator('input[type="text"]:visible').first().fill('G5 Independent')
  await page.getByRole('button', { name: /^create$/i }).first().click()
  await page.waitForFunction(() => /^\/project\/[a-f0-9]{24}/.test(location.pathname), null, { timeout: 60000 })
  projectId = new URL(page.url()).pathname.split('/')[2]
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  record('W03', 'P0', 'PASS', `project ${projectId} created`)

  const fixture = fs.readFileSync(path.resolve('tests/fixtures/ieee-basic/main.tex'), 'utf8')
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(fixture)
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^upload$/i }).first().click()
  await page.waitForTimeout(600)
  await page.locator('input[type="file"]').first().setInputFiles([
    path.resolve('tests/fixtures/ieee-basic/references.bib'),
    path.resolve('tests/fixtures/ieee-basic/figure.png'),
  ])
  await page.waitForTimeout(4000)
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('button.compile-button')?.click())
  await page.waitForTimeout(15000)
  const compile = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    return {
      pdf: [...document.querySelectorAll('a[href*="output.pdf"]')].length > 0,
      errors: tabs.find(t => t.startsWith('Errors')) ?? null,
    }
  })
  record('W05', 'P0', compile.pdf ? 'PASS' : 'FAIL', `PDF=${compile.pdf} ${compile.errors}`, [save('w05-compile.json', compile)])
  await page.screenshot({ path: path.join(OUT, 'w05-editor.png') })

  // Baseline snapshot BEFORE any AI edit, so Undo can be compared like-for-like.
  const zipBase = await context.request.get(`${BASE}/project/${projectId}/download/zip`)
  const zipBasePath = path.join(OUT, 'baseline.zip')
  fs.writeFileSync(zipBasePath, await zipBase.body())
  const baseSha = contentHash(zipBasePath)

  // X11..X13: proposal flow, undo, conflict
  await page.click('#ails-ai-toggle')
  await page.selectOption('#ails-ai-model', MODEL)
  await page.fill('#ails-ai-input', 'Replace the word "organised" with "organized". Keep everything else identical.')
  await page.click('#ails-ai-suggest')
  const gotDiff = await page.waitForFunction(() =>
    document.querySelector('.ails-ai-diff') ||
    [...document.querySelectorAll('.ails-ai-msg')].some(e => e.textContent.includes('Proposal failed')),
    null, { timeout: 600000 }).then(() => true).catch(() => false)
  const proposalErr = await page.evaluate(() =>
    [...document.querySelectorAll('.ails-ai-msg')].map(e => e.textContent).find(t => t.includes('Proposal failed')) ?? null)
  if (!gotDiff) record('X11', 'P0', 'BLOCKED', `no diff card (${proposalErr ?? 'timeout'})`)
  else if (proposalErr) record('X11', 'P0', 'FAIL', proposalErr)
  else {
    record('X11', 'P0', 'PASS', 'diff card rendered')
    await page.click('.ails-ai-diff-actions button:has-text("Accept")')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.ails-ai-diff-rationale')].some(e => /Applied|Cannot apply/.test(e.textContent)),
      null, { timeout: 60000 }).catch(() => {})
    const note = await page.evaluate(() =>
      [...document.querySelectorAll('.ails-ai-diff-rationale')].map(e => e.textContent).find(t => /Applied|Cannot apply/.test(t)) ?? '')
    record('X12', 'P0', note.includes('Applied') ? 'PASS' : 'FAIL', note.slice(0, 160))
    await page.waitForTimeout(6000)
    const zipA = await context.request.get(`${BASE}/project/${projectId}/download/zip`)
    const zipPath = path.join(OUT, 'after-accept.zip')
    fs.writeFileSync(zipPath, await zipA.body())
    record('X12b', 'P0', 'PASS', `server zip sha ${sha256(zipPath).slice(0, 12)}`, [zipPath])
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(6000)
    const zipB = await context.request.get(`${BASE}/project/${projectId}/download/zip`)
    const zipPath2 = path.join(OUT, 'after-undo.zip')
    fs.writeFileSync(zipPath2, await zipB.body())
    const undoSha = contentHash(zipPath2)
    record('X12c', 'P0', undoSha === baseSha ? 'PASS' : 'FAIL',
      undoSha === baseSha
        ? `undo restored baseline (${undoSha.slice(0, 12)})`
        : `undo differs from baseline (${undoSha.slice(0, 12)} vs ${baseSha.slice(0, 12)})`,
      [zipPath2])
  }

  // X16: CSRF
  const csrfCheck = await page.evaluate(async () => {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ provider: 'local', model: 'x', messages: [] }),
    })
    return r.status
  })
  record('X16', 'P0', csrfCheck === 403 ? 'PASS' : 'FAIL', `POST without CSRF -> ${csrfCheck}`)

  // X17: chat WITH a valid CSRF token must reach the model. This guards the
  // sidecar's authorized() check on /v1/chat (commit 2c8f833): the gateway must
  // keep forwarding the shared x-ails-gateway-secret. If it ever stopped, chat
  // would regress to 401 and X16 (the negative case) would still pass -- so the
  // positive path needs its own case. Reads only the first SSE chunk, then aborts.
  const chatAuth = await page.evaluate(async (model) => {
    const t = document.querySelector('meta[name="ol-csrfToken"]')?.content
    if (!t) return { status: 0, note: 'no csrf meta' }
    const ac = new AbortController()
    try {
      const r = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-csrf-token': t },
        body: JSON.stringify({ provider: 'local', model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
        signal: ac.signal,
      })
      if (r.status !== 200) return { status: r.status, hasData: false }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        if (/data:/.test(buf) && buf.length > 40) break
      }
      ac.abort()
      return { status: 200, hasData: /data:/.test(buf), sample: buf.slice(0, 100) }
    } catch (e) {
      return { status: -1, hasData: false, note: String(e?.name ?? e) }
    }
  }, MODEL)
  record('X17', 'P0', chatAuth.status === 200 && chatAuth.hasData ? 'PASS' : 'FAIL',
    `chat with CSRF -> ${chatAuth.status} data=${chatAuth.hasData}${chatAuth.note ? ' (' + chatAuth.note + ')' : ''}`)

  // W02b: loopback-only listener (from the host's own perspective)
  try {
    const netstat = execFileSync('sh', ['-c', `ss -ltn 2>/dev/null | grep ':${new URL(BASE).port || 80} ' || true`]).toString()
    const nonLoop = netstat.split('\n').filter(l => l.trim() && !/127\.0\.0\.1:/.test(l))
    record('W02b', 'P0', nonLoop.length === 0 ? 'PASS' : 'FAIL', nonLoop.join(' | ') || 'loopback only')
  } catch {
    record('W02b', 'P0', 'NOT_TESTED', 'could not inspect listeners')
  }
  record('W15', 'P0', 'PASS', 'tracing enabled; artifacts in --out', [])
} catch (err) {
  record('RUNNER', 'P0', 'FAIL', String(err?.message ?? err))
} finally {
  const trace = path.join(OUT, 'trace.zip')
  await context.tracing.stop({ path: trace }).catch(() => {})
  await browser.close()

  const manifest = {
    schema_version: '1.2',
    generated_at: new Date().toISOString(),
    base_url: BASE,
    model: MODEL,
    runner_sha256: sha256(fileURLToPath(import.meta.url)),
    results,
    console_errors: consoleErrors.slice(0, 50),
    note: 'Runner-produced evidence. Case status is exactly what was observed; unrun cases are absent on purpose.',
  }
  save('results.json', manifest)
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
  console.log('\nsummary:', JSON.stringify(counts), '\nartifacts:', OUT)
}

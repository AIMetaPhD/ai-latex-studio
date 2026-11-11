// G1 probe: REA (passive CDP forensics) and Playwright (driver) attached to the SAME
// dedicated Chromium. Steps:
// 1. spawn a dedicated Chromium (own profile, loopback CDP 9333)
// 2. Playwright connectOverCDP -> login -> open the compiled project
// 3. rea list-browser-targets -> target id
// 4. rea capture-web-screenshot -> raw evidence JSON
// 5. modify the page via Playwright, then rea compare two screenshots (before/after)
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { ensureArtifacts, BASE, ADMIN, ARTIFACTS, CHROME } from './lib.mjs'

// On Windows, npm globals are .cmd shims; resolve the real path once.
const REA_BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? '', 'npm', 'rea.cmd')
  : 'rea'
const exec = (args, opts) =>
  promisify(execFile)(REA_BIN, args, { shell: true, ...opts })
const CDP = 'http://127.0.0.1:9333'
const PROFILE = path.resolve(import.meta.dirname, '../rea-profile-g1')
const report = { startedAt: new Date().toISOString(), base: BASE, cdp: CDP, steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 400)}`)
}

ensureArtifacts()
fs.rmSync(PROFILE, { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })

const chrome = await new Promise((resolve, reject) => {
  const p = execFile(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${new URL(CDP).port}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    err => {
      if (err && !p.killed) reject(err)
    }
  )
  p.on('exit', code => report.exitCodeFromChrome === undefined && step('chrome-exited', { code }))
  resolve(p)
})
process.on('exit', () => { try { chrome.kill() } catch {} })

try {
  // wait for the CDP endpoint
  let version
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${CDP}/json/version`)
      version = await r.json()
      break
    } catch {
      await new Promise(res => setTimeout(res, 500))
    }
  }
  if (!version) throw new Error('CDP endpoint never came up')
  step('cdp-up', { browser: version.Browser })

  const browser = await chromium.connectOverCDP(CDP)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })

  // Playwright drives the real workflow
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', ADMIN.email)
  await page.fill('input[name="password"]', ADMIN.password)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => location.pathname.startsWith('/project'), null, { timeout: 30000 })
  step('playwright-logged-in', { url: page.url() })

  const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)
  step('playwright-project-open', { projectId })

  // REA discovers targets from the same CDP endpoint
  const { stdout: targetsJson } = await exec(['list-browser-targets', CDP, '--json'])
  const targets = JSON.parse(targetsJson)
  const pageTarget = targets.normalized_result?.targets?.find(t => t.url?.includes('/project/'))
  step('rea-targets', {
    evidence_id: targets.evidence_id,
    count: targets.normalized_result?.targets?.length,
    shape: pageTarget ? Object.keys(pageTarget) : [],
    selected: pageTarget ? JSON.stringify(pageTarget).slice(0, 240) : null,
  })
  if (!pageTarget) throw new Error('REA found no /project page target')
  const targetId = pageTarget.id ?? pageTarget.target_id ?? pageTarget.targetId
  if (!targetId) throw new Error('REA target record has no id field: ' + JSON.stringify(pageTarget).slice(0, 300))

  // REA passively captures the current viewport.
  // compare-web-screenshots consumes the {sha256,bytes,media_type,data_base64}
  // artifact record, not the whole evidence envelope.
  const capture = async (target, name) => {
    const file = path.join(ARTIFACTS, name + '.json')
    const artFile = path.join(ARTIFACTS, name + '.artifact.json')
    const r = await exec(
      ['capture-web-screenshot', CDP, target, '--json', '--full-output'],
      { maxBuffer: 20 * 1024 * 1024 }
    )
    fs.writeFileSync(file, r.stdout)
    const env = JSON.parse(r.stdout)
    const artifact = env.data?.normalized_result?.artifact
    fs.writeFileSync(artFile, JSON.stringify(artifact))
    return { file: name + '.json', bytes: fs.statSync(file).size, artifact: artifact?.sha256?.slice(0, 16) }
  }
  const shot1info = await capture(targetId, 'rea-screenshot-before')
  step('rea-screenshot-1', shot1info)
  const shot1 = path.join(ARTIFACTS, 'rea-screenshot-before.artifact.json')

  // Playwright changes the UI; REA captures again and compares
  await page.getByRole('button', { name: /recompile$/i }).first().click().catch(() =>
    page.evaluate(() => document.querySelector('button.compile-button')?.click())
  )
  await page.waitForTimeout(5000)
  const shot2info = await capture(targetId, 'rea-screenshot-after')
  step('rea-screenshot-2', shot2info)
  const shot2 = path.join(ARTIFACTS, 'rea-screenshot-after.artifact.json')

  const { stdout: cmpJson } = await exec(
    ['compare-web-screenshots', shot1, shot2, '--json'],
    { maxBuffer: 10 * 1024 * 1024 }
  )
  const cmp = JSON.parse(cmpJson)
  step('rea-compare', {
    evidence_id: cmp.evidence_id,
    summary: JSON.stringify(cmp.normalized_result ?? cmp.raw_result ?? {}).slice(0, 400),
  })

  report.passed = true
} catch (err) {
  report.passed = false
  report.error = String(err)
  step('error', { message: String(err) })
} finally {
  fs.writeFileSync(path.join(ARTIFACTS, '06-rea.json'), JSON.stringify(report, null, 2))
  try { chrome.kill() } catch {}
  console.log(report.passed ? 'PASS 06-rea-playwright' : `FAIL 06-rea-playwright: ${report.error}`)
}

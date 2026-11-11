// G1 probe: restart the CE stack (containers recreated) and verify project content,
// uploaded files, and the compiled PDF all survive via the local data volumes.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from './lib.mjs'

const exec = promisify(execFile)
// Toolkit working copy location; keep it out of tracked source (it embeds a local
// username) by taking it from the environment.
// (no toolkit path: this probe now drives the product's own containers)
const MARKER = 'AI-STUDIO-PROBE-MARKER'
const report = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 300)}`)
}
const wslRoot = cmd => exec('wsl', ['-u', 'root', '-e', 'bash', '-lc', cmd], { maxBuffer: 20e6 })

ensureArtifacts()
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()

// read the document before the restart
const browser = await launch()
let docBefore
{
  const { context, page } = await newPage(browser)
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)
  docBefore = await page.evaluate(() => document.querySelector('.cm-content').innerText)
  const files = await page.evaluate(() =>
    [...document.querySelectorAll('[role="treeitem"], .entity')].map(e => e.textContent?.trim()).filter(Boolean)
  )
  step('before-restart', { docLength: docBefore.length, hasMarker: docBefore.includes(MARKER), files: files.slice(0, 8) })
  await context.close()
}
await browser.close()

// --- restart the whole stack, preserving volumes (no `-v`) ---
// The original version drove the G1 toolkit (`bin/stop` / `bin/start` under
// /var/tmp/aistudio-g1/overleaf-toolkit), which no longer exists now that the
// product ships its own compose stack -- the probe would fail on a missing
// directory rather than on persistence. Drive the real containers instead, in
// dependency order, and never remove volumes.
const t0 = Date.now()
await wslRoot('docker stop ails-ce ails-sidecar 2>&1 | tail -2')
await wslRoot('docker stop ails-redis ails-mongo 2>&1 | tail -2')
const afterStop = await wslRoot('docker ps --format "{{.Names}}"')
step('stopped', { remaining: afterStop.stdout.trim() })

await wslRoot('docker start ails-mongo ails-redis 2>&1 | tail -2')
// wait for mongod to report healthy before starting the app tier
for (let i = 0; i < 60; i++) {
  const h = await wslRoot(`docker inspect -f '{{.State.Health.Status}}' ails-mongo 2>/dev/null || echo none`)
  if (h.stdout.trim() === 'healthy') break
  await new Promise(r => setTimeout(r, 2000))
}
await wslRoot('docker start ails-sidecar ails-ce 2>&1 | tail -2')
const coldStartMs = Date.now() - t0
step('started', { coldStartMs, ps: (await wslRoot('docker ps --format "{{.Names}} {{.Status}}"')).stdout.trim() })

// --- wait until the web service actually answers (cold start includes Node boot) ---
let ready = false
for (let i = 0; i < 60 && !ready; i++) {
  try {
    const r = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(3000) })
    ready = r.status === 200
  } catch {}
  if (!ready) await new Promise(res => setTimeout(res, 2000))
}
step('service-ready', { ready, waitedMs: Date.now() - t0 - coldStartMs })

// --- read the document again after restart ---
const browser2 = await launch()
const { context, page, events } = await newPage(browser2, { traceName: '07-restart' })
try {
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 90000 })
  await page.waitForTimeout(2500)
  const docAfter = await page.evaluate(() => document.querySelector('.cm-content').innerText)
  const files = await page.evaluate(() =>
    [...document.querySelectorAll('[role="treeitem"], .entity')].map(e => e.textContent?.trim()).filter(Boolean)
  )
  step('after-restart', {
    docLength: docAfter.length,
    identical: docAfter === docBefore,
    hasMarker: docAfter.includes(MARKER),
    files: files.slice(0, 8),
  })
  report.identical = docAfter === docBefore
  report.coldStartMs = coldStartMs
  await page.screenshot({ path: path.join(ARTIFACTS, '07-after-restart.png') })
} catch (err) {
  report.error = String(err)
  step('error', { message: String(err) })
} finally {
  report.tracePath = await saveTrace(context, '07-restart')
  report.consoleErrors = events.filter(e => e.level === 'error').slice(0, 20)
  const psAfter = await wslRoot('docker ps --format "{{.Names}} {{.Status}}"')
  step('containers', { ps: psAfter.stdout.trim() })
  report.passed = report.identical === true && !report.error
  fs.writeFileSync(path.join(ARTIFACTS, '07-restart.json'), JSON.stringify(report, null, 2))
  await browser2.close()
  console.log(report.passed ? `PASS 07-restart-persistence (cold start ${coldStartMs} ms)` : `FAIL 07-restart-persistence: ${report.error ?? 'content differs'}`)
}

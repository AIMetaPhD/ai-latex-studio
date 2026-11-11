// G1 probe (authoritative): prove the CE native edit pipeline persists BOTH
// directions — an EditorView.dispatch insert reaches the server (ZIP export),
// and a subsequent Undo also reaches the server. innerText is not authoritative;
// the project ZIP download is.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from './lib.mjs'

const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
const MARKER = '% AI-STUDIO-PROBE-08\n'
const report = { startedAt: new Date().toISOString(), projectId, steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 300)}`)
}

ensureArtifacts()

const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const exec = promisify(execFile)

// unzip the project through PowerShell into a temp dir and read main.tex
async function serverMainTex(context, label) {
  // CE route: /project/:Project_id/download/zip (case-sensitive, see router.mjs)
  const url = `${BASE}/project/${projectId}/download/zip`
  const res = await context.request.get(url, { failOnStatusCode: false })
  if (res.status() !== 200) throw new Error(`zip export failed: ${res.status()}`)
  return readMain(await res.body(), label, url)
}

async function readMain(body, label, url) {
  const zipFile = path.join(ARTIFACTS, `08-${label}.zip`)
  const dir = path.join(ARTIFACTS, `08-${label}`)
  fs.writeFileSync(zipFile, body)
  fs.rmSync(dir, { recursive: true, force: true })
  const winZip = zipFile.replace(/\//g, '\\')
  const winDir = dir.replace(/\//g, '\\')
  await exec(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${winZip}' -DestinationPath '${winDir}' -Force`]
  )
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  )
  const mainFile = walk(dir).find(f => /main\.tex$/.test(f))
  const tex = mainFile ? fs.readFileSync(mainFile, 'utf8') : ''
  const sha = crypto.createHash('sha256').update(tex).digest('hex')
  step(`server-tex-${label}`, {
    url,
    zipBytes: body.length,
    texBytes: Buffer.byteLength(tex),
    sha256_12: sha.slice(0, 12),
    hasMarker: tex.includes('AI-STUDIO-PROBE-08'),
    files: walk(dir).map(f => path.relative(dir, f).replaceAll('\\', '/')),
  })
  return { tex, sha, hasMarker: tex.includes('AI-STUDIO-PROBE-08') }
}

const browser = await launch()
const { context, page, events } = await newPage(browser, { traceName: '08-persist' })
try {
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)

  const base = await serverMainTex(context, 'base')
  if (base.hasMarker) throw new Error('marker unexpectedly already present; run against a clean project')

  // dispatch an insert through the CM6 pipeline
  await page.evaluate(marker => {
    const view = document.querySelector('.cm-content').cmView.view
    view.dispatch({ changes: { from: view.state.doc.length, insert: marker }, userEvent: 'input.type' })
  }, MARKER)
  await page.waitForTimeout(6000) // allow real-time flush

  const afterInsert = await serverMainTex(context, 'after-insert')
  step('insert-persisted', afterInsert.hasMarker)

  // undo through the UI
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(6000)

  const afterUndo = await serverMainTex(context, 'after-undo')
  step('undo-persisted', afterUndo.sha256_12)

  report.passed = afterInsert.hasMarker === true && afterUndo.hasMarker === false
  report.shaBase = base.sha.slice(0, 16)
  report.shaAfterInsert = afterInsert.sha.slice(0, 16)
  report.shaAfterUndo = afterUndo.sha.slice(0, 16)
  report.shaRestored = afterUndo.sha === base.sha
} catch (err) {
  report.error = String(err)
  step('error', { message: String(err) })
} finally {
  report.tracePath = await saveTrace(context, '08-persist')
  report.consoleErrors = events.filter(e => e.level === 'error').slice(0, 30)
  fs.writeFileSync(path.join(ARTIFACTS, '08-persist.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS 08-server-persistence' : `FAIL 08-server-persistence: ${report.error ?? 'assertions failed'}`)
}

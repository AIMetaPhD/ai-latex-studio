// G1/R-04 decisive experiment: compare the editor's hydrated view against the
// authoritative server ZIP, in the SAME fresh session, twice with a wait between.
// Distinguishes "editor hydration lag / innerText unreliability" from a real
// server-side flip-flop of document content.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from './lib.mjs'

const exec = promisify(execFile)
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
const MARKER = 'AI-STUDIO-PROBE-MARKER'
const report = { startedAt: new Date().toISOString(), projectId, samples: [] }
const sample = s => { report.samples.push({ ...s, at: new Date().toISOString() }); console.error(JSON.stringify(s)) }

async function serverTex(context, label) {
  const res = await context.request.get(`${BASE}/project/${projectId}/download/zip`)
  if (res.status() !== 200) throw new Error(`zip ${res.status()}`)
  const zipFile = path.join(ARTIFACTS, `09-${label}.zip`)
  const dir = path.join(ARTIFACTS, `09-${label}`)
  fs.writeFileSync(zipFile, await res.body())
  fs.rmSync(dir, { recursive: true, force: true })
  await exec('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipFile.replace(/\//g, '\\')}' -DestinationPath '${dir.replace(/\//g, '\\')}' -Force`])
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const f = walk(dir).find(p => /main\.tex$/.test(p))
  const tex = fs.readFileSync(f, 'utf8')
  return { sha: crypto.createHash('sha256').update(tex).digest('hex').slice(0, 12), hasMarker: tex.includes(MARKER), bytes: Buffer.byteLength(tex) }
}

ensureArtifacts()
const browser = await launch()
const { context, page } = await newPage(browser, { traceName: '09-hydration' })
try {
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })

  for (const [label, waitMs] of [['t+3s', 3000], ['t+60s', 57000], ['t+180s', 120000]]) {
    await page.waitForTimeout(waitMs)
    const view = await page.evaluate(() => document.querySelector('.cm-content')?.innerText ?? '')
    const server = await serverTex(context, label)
    sample({ label, editorLength: view.length, editorHasMarker: view.includes(MARKER), ...server })
  }

  // Does the docstore GET endpoint (what real-time serves on hydration) agree with the ZIP?
  const doc = await context.request.get(`${BASE}/project/${projectId}/doc/main`, { failOnStatusCode: false })
  sample({ label: 'docstore-get', status: doc.status(), body: (await doc.text()).slice(0, 200) })

  report.conclusion = 'see samples'
} catch (err) {
  report.error = String(err)
} finally {
  report.tracePath = await saveTrace(context, '09-hydration')
  fs.writeFileSync(path.join(ARTIFACTS, '09-hydration.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.error ? `FAIL: ${report.error}` : 'DONE 09-hydration')
}

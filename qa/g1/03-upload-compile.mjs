// G1 probe (continued): upload .bib/.png into an existing project, recompile,
// then use the compile response itself (build id + output URLs) to fetch the PDF and log.
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, genAdmin, login, BASE, ARTIFACTS } from './lib.mjs'

const FIXTURE = path.resolve(import.meta.dirname, '../../tests/fixtures/ieee-basic')
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
const report = { startedAt: new Date().toISOString(), projectId, steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 400)}`)
}

ensureArtifacts()
const browser = await launch()
const { context, page, events } = await newPage(browser, { traceName: '03-upload' })

try {
  const reg = await genAdmin(page)
  if (!reg.created) await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })

  const unstable = await page.evaluate(() => ({
    exists: !!window.overleaf?.unstable,
    keys: Object.keys(window.overleaf?.unstable ?? {}),
  }))
  step('overleaf-unstable', unstable)

  // --- upload supporting files ---
  await page.getByRole('button', { name: /^upload$/i }).first().click()
  await page.waitForTimeout(800)
  const inputs = page.locator('input[type="file"]')
  const inputCount = await inputs.count()
  step('upload-input', { count: inputCount })
  const uploads = []
  page.on('response', r => {
    if (/\/upload/.test(r.url())) uploads.push({ url: r.url(), status: r.status() })
  })
  await inputs.first().setInputFiles([
    path.join(FIXTURE, 'references.bib'),
    path.join(FIXTURE, 'figure.png'),
  ])
  await page.waitForTimeout(5000)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  step('upload-responses', { uploads })
  const entities = await page.evaluate(() =>
    [...document.querySelectorAll('[role="treeitem"], .entity, [data-file-id]')]
      .map(e => e.textContent?.trim())
      .filter(Boolean)
      .slice(0, 20)
  )
  step('tree-entities', { entities })

  // --- compile and capture the compile API response ---
  const compileResponse = page.waitForResponse(r => /\/compile(\?|$)/.test(r.url()) && r.request().method() === 'POST', {
    timeout: 180000,
  })
  const recompile = page.locator('button.compile-button, button:has-text("Recompile")').first()
  await recompile.click({ timeout: 15000 }).catch(async () => {
    // The toolbar button can be occluded by the upload dialog; fall back to a DOM click.
    await page.evaluate(() => document.querySelector('button.compile-button')?.click())
  })
  const res = await compileResponse
  const payload = await res.json()
  const outputFiles = (payload.outputFiles ?? []).map(f => ({ path: f.path, url: f.url }))
  step('compile-response', {
    status: res.status(),
    compileStatus: payload.status,
    buildId: payload.buildId ?? null,
    clsiServerId: payload.clsiServerId ?? null,
    outputFiles,
  })
  fs.writeFileSync(path.join(ARTIFACTS, '03-compile-response.json'), JSON.stringify(payload, null, 2))

  const fetchOut = async (entry, filename) => {
    const url = new URL(entry.url, BASE).toString()
    const r = await context.request.get(url, { failOnStatusCode: false })
    const body = await r.body()
    fs.writeFileSync(path.join(ARTIFACTS, filename), body)
    return { status: r.status(), bytes: body.length, body }
  }

  let logText = ''
  const logEntry = outputFiles.find(f => f.path === 'output.log')
  if (logEntry) {
    const log = await fetchOut(logEntry, '03-output.log')
    logText = log.body.toString('utf8')
    step('log', {
      status: log.status,
      bytes: logText.length,
      errors: (logText.match(/^! .*/gm) ?? []).slice(0, 5),
      outputWritten: (logText.match(/Output written on .*?\((\d+) pages?/) ?? [])[1] ?? null,
    })
  }

  const pdfEntry = outputFiles.find(f => f.path === 'output.pdf')
  let header = ''
  if (pdfEntry) {
    const pdf = await fetchOut(pdfEntry, '03-output.pdf')
    header = pdf.body.subarray(0, 5).toString('latin1')
    step('pdf', { status: pdf.status, bytes: pdf.bytes, isPdf: header === '%PDF-' })
  } else {
    step('pdf', { missing: true })
  }

  report.passed = header === '%PDF-' && payload.status === 'success' && !/^! /m.test(logText)
  await page.screenshot({ path: path.join(ARTIFACTS, '03-compiled.png') })
} catch (err) {
  report.passed = false
  report.error = String(err)
  step('error', { message: String(err) })
  await page.screenshot({ path: path.join(ARTIFACTS, '03-error.png') }).catch(() => {})
} finally {
  report.tracePath = await saveTrace(context, '03-upload')
  report.consoleErrors = events.filter(e => e.type !== 'console' || e.level === 'error').slice(0, 40)
  fs.writeFileSync(path.join(ARTIFACTS, '03-upload.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS 03-upload-compile' : `FAIL 03-upload-compile: ${report.error}`)
}

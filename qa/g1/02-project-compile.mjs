// G1 probe: create a project, type LaTeX into the CodeMirror editor, upload .bib/.png,
// compile to PDF, and record editor internals. Minimal assertions; every step recorded.
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, genAdmin, login, BASE, ARTIFACTS } from './lib.mjs'

const FIXTURE = path.resolve(import.meta.dirname, '../../tests/fixtures/ieee-basic')
const MAIN_TEX = fs.readFileSync(path.join(FIXTURE, 'main.tex'), 'utf8')
const report = { startedAt: new Date().toISOString(), base: BASE, steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  process.stderr.write(`[${name}] ${JSON.stringify(data).slice(0, 300)}\n`)
}

ensureArtifacts()
const browser = await launch()
const { context, page, events } = await newPage(browser, { traceName: '02-project' })

try {
  await login(page)
  step('logged-in', { url: page.url() })

  // --- create a blank project through the UI ---
  await page.getByRole('button', { name: /new project/i }).first().click()
  await page.waitForTimeout(400)
  const blank = page.getByRole('menuitem', { name: /blank project/i })
  if (await blank.count()) {
    await blank.first().click()
  } else {
    await page.getByText(/blank project/i).first().click()
  }
  await page.waitForTimeout(500)
  const nameInput = page.locator('input[type="text"]:visible').first()
  await nameInput.fill('G1 Smoke IEEE')
  await page.getByRole('button', { name: /^create$/i }).first().click()
  await page.waitForFunction(() => /^\/project\/[a-f0-9]{24}/.test(location.pathname), null, {
    timeout: 60000,
  })
  const projectId = new URL(page.url()).pathname.split('/')[2]
  step('project-created', { url: page.url(), projectId })

  // --- wait for CodeMirror 6 and type the fixture ---
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  const cmInfo = await page.evaluate(() => ({
    cmEditors: document.querySelectorAll('.cm-editor').length,
    hasOverleafGlobal: typeof window.overleaf !== 'undefined',
    overleafKeys: window.overleaf ? Object.keys(window.overleaf) : [],
  }))
  step('codemirror', cmInfo)

  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(MAIN_TEX)
  await page.waitForTimeout(1500)

  // --- upload .bib and .png through the file tree ---
  // The file input only exists once the Upload dialog is open. Without clicking
  // Upload first, `input[type=file]` count is 0 and this block silently skipped --
  // the project then had only main.tex, so every compile carried a permanent
  // missing-bibliography error (measured: file-inputs-present count:0, and the
  // exported zip contained just main.tex). Mirror the G5 flow that works.
  await page.getByRole('button', { name: /^upload$/i }).first().click()
  await page.waitForTimeout(600)
  const fileInputs = await page.locator('input[type="file"]').count()
  step('file-inputs-present', { count: fileInputs })
  if (fileInputs > 0) {
    await page.locator('input[type="file"]').first().setInputFiles([
      path.join(FIXTURE, 'references.bib'),
      path.join(FIXTURE, 'figure.png'),
    ])
    await page.waitForTimeout(4000)
    await page.keyboard.press('Escape')
  } else {
    step('upload-input-missing', { note: 'Upload dialog did not expose a file input' })
  }

  // --- compile ---
  const recompile = page.getByRole('button', { name: /recompile/i }).first()
  await recompile.click()
  await page.waitForTimeout(1500)
  const downloadLink = page.locator('a[href*="/output/output.pdf"], a[download$=".pdf"]').first()
  await downloadLink.waitFor({ timeout: 120000 }).catch(() => {})
  step('compiled', {
    pdfLink: (await downloadLink.count()) ? await downloadLink.getAttribute('href') : null,
  })

  // --- fetch the produced PDF with the session cookie ---
  // Use the real link the UI exposes (/download/project/<id>/build/<buildId>/...).
  // The old `${BASE}/project/<id>/output/output.pdf` shape is a legacy route that
  // returns 404 on CE 6.x, so this step used to record status:404 for a healthy
  // compile and could never have asserted isPdf.
  const linkHref = (await downloadLink.count()) ? await downloadLink.getAttribute('href') : null
  const pdfUrl = linkHref ? new URL(linkHref, BASE).toString() : `${BASE}/project/${projectId}/output/output.pdf?compileGroup=standard`
  const res = await context.request.get(pdfUrl)
  const pdfBody = await res.body()
  const pdfPath = path.join(ARTIFACTS, '02-output.pdf')
  fs.writeFileSync(pdfPath, pdfBody)
  const pdfHeader = pdfBody.subarray(0, 5).toString('latin1')
  step('pdf-downloaded', {
    status: res.status(),
    bytes: pdfBody.length,
    header: pdfHeader,
    isPdf: pdfHeader === '%PDF-',
  })

  // --- compile log ---
  // Derive the log URL from the same build path as the PDF; the legacy
  // `/project/<id>/output/output.log` route 404s on CE 6.x.
  const logUrl = linkHref
    ? new URL(linkHref, BASE).toString().replace(/output\.pdf.*$/, 'output.log')
    : `${BASE}/project/${projectId}/output/output.log`
  const logRes = await context.request.get(logUrl, { failOnStatusCode: false })
  const logText = (await logRes.text()).slice(0, 4000)
  fs.writeFileSync(path.join(ARTIFACTS, '02-output.log'), logText)
  step('log-fetched', {
    status: logRes.status(),
    hasErrors: /^! /m.test(logText),
    pages: (logText.match(/Output written on .* \((\d+) pages?/) ?? [])[1] ?? null,
  })

  await page.screenshot({ path: path.join(ARTIFACTS, '02-editor.png'), fullPage: false })
  fs.writeFileSync(path.join(ARTIFACTS, '02-project-id.txt'), projectId)
  report.projectId = projectId
  report.passed = true
} catch (err) {
  report.passed = false
  report.error = String(err)
  step('error', { message: String(err) })
  await page.screenshot({ path: path.join(ARTIFACTS, '02-error.png'), fullPage: false }).catch(() => {})
} finally {
  report.tracePath = await saveTrace(context, '02-project')
  report.consoleErrors = events
    .filter(e => e.type !== 'console' || e.level === 'error')
    .slice(0, 60)
  fs.writeFileSync(path.join(ARTIFACTS, '02-project.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS 02-project-compile' : `FAIL 02-project-compile: ${report.error}`)
}

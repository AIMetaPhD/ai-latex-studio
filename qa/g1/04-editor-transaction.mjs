// G1 probe: can we reach the live CodeMirror 6 EditorView from the page, dispatch a
// transaction, keep it as ONE undo step, and have it survive a reload (i.e. reach the
// OT pipeline and the server)?
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, genAdmin, login, BASE, ARTIFACTS } from './lib.mjs'

const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
const MARKER = '\n% AI-STUDIO-PROBE-MARKER\n'
const report = { startedAt: new Date().toISOString(), projectId, steps: [] }
const step = (name, data = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.error(`[${name}] ${JSON.stringify(data).slice(0, 400)}`)
}

ensureArtifacts()
const browser = await launch()
const { context, page, events } = await newPage(browser, { traceName: '04-editor' })

const readDoc = page =>
  page.evaluate(() => document.querySelector('.cm-content')?.innerText ?? '')

try {
  const reg = await genAdmin(page)
  if (!reg.created) await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)

  // How is the EditorView reachable? CE does not expose it on window.overleaf.
  const access = await page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    const editor = document.querySelector('.cm-editor')
    return {
      contentCmView: !!content?.cmView,
      editorCmView: !!editor?.cmView,
      contentView: !!content?.cmView?.view,
      rootHasView: !!editor?.cmView?.rootView,
      docLength: (document.querySelector('.cm-content')?.innerText ?? '').length,
    }
  })
  step('editor-access', access)

  const before = await readDoc(page)
  const dispatchResult = await page.evaluate(marker => {
    const view = document.querySelector('.cm-content')?.cmView?.view
    if (!view) return { ok: false, reason: 'no EditorView reachable from DOM' }
    const { state } = view
    view.dispatch({
      changes: { from: state.doc.length, insert: marker },
      selection: { anchor: state.doc.length + marker.length },
      userEvent: 'input.type',
    })
    return { ok: true, lengthAfter: view.state.doc.length }
  }, MARKER)
  step('dispatch', dispatchResult)
  await page.waitForTimeout(1500)

  const afterDispatch = await readDoc(page)
  step('after-dispatch', {
    grewBy: afterDispatch.length - before.length,
    containsMarker: afterDispatch.includes('AI-STUDIO-PROBE-MARKER'),
  })

  // One undo should remove the whole inserted block.
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(1500)
  const afterUndo = await readDoc(page)
  step('after-undo', {
    equalToBefore: afterUndo === before,
    stillHasMarker: afterUndo.includes('AI-STUDIO-PROBE-MARKER'),
  })

  // Redo, then reload to prove the change reached the server through OT.
  await page.keyboard.press('Control+y')
  await page.waitForTimeout(2500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)
  const afterReload = await readDoc(page)
  step('after-reload', {
    persisted: afterReload.includes('AI-STUDIO-PROBE-MARKER'),
    length: afterReload.length,
  })

  await page.screenshot({ path: path.join(ARTIFACTS, '04-after-reload.png') })
  report.passed =
    dispatchResult.ok === true &&
    afterDispatch.includes('AI-STUDIO-PROBE-MARKER') &&
    afterUndo === before &&
    afterReload.includes('AI-STUDIO-PROBE-MARKER')
} catch (err) {
  report.passed = false
  report.error = String(err)
  step('error', { message: String(err) })
  await page.screenshot({ path: path.join(ARTIFACTS, '04-error.png') }).catch(() => {})
} finally {
  report.tracePath = await saveTrace(context, '04-editor')
  report.consoleErrors = events.filter(e => e.type !== 'console' || e.level === 'error').slice(0, 40)
  fs.writeFileSync(path.join(ARTIFACTS, '04-editor.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS 04-editor-transaction' : `FAIL 04-editor-transaction: ${report.error}`)
}

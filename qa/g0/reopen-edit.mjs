// After a restore, the restored project must still be EDITABLE, and the edit
// must survive a reload (i.e. it reached the collaboration server, not just the
// local view). Browser-side counterpart of reopen-check.mjs.
//   node qa/g0/reopen-edit.mjs <base> <projectId>
import { launch, newPage, login, BASE } from '../g1/lib.mjs'

const PID = process.argv[3]
if (!PID) { console.error('usage: reopen-edit.mjs <base> <projectId>'); process.exit(2) }
const base = (process.argv[2] || BASE).replace(/\/$/, '')
const MARKER = ` % restored-edit-${Date.now()}`

const out = { base, projectId: PID, marker: MARKER, at: new Date().toISOString() }
const browser = await launch()
const { page } = await newPage(browser, { traceName: 'g0-reopen-edit' })
try {
  await login(page)
  await page.goto(`${base}/project/${PID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)

  out.opened = true
  const dispatch = await page.evaluate(marker => {
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
  out.dispatch = dispatch
  await page.waitForTimeout(2000)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)
  out.persistedAfterReload = await page.evaluate(m => (document.querySelector('.cm-content')?.innerText ?? '').includes(m), MARKER)
  await browser.close()
  out.ok = Boolean(dispatch.ok && out.persistedAfterReload)
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
} catch (err) {
  out.error = String(err && err.message ? err.message : err)
  console.log(JSON.stringify(out, null, 2))
  try { await browser.close() } catch {}
  process.exit(1)
}

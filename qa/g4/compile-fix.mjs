// G4 P08: real compile error -> AI proposal -> manual Accept -> real Recompile
// must succeed before we may claim "fixed". No success is inferred from the edit.
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from '../g1/lib.mjs'

const report = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data = {}) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.error(`[${name}]`, JSON.stringify(data).slice(0, 300)) }

ensureArtifacts()
const browser = await launch()
const { context, page } = await newPage(browser, { traceName: 'g4-compilefix' })
try {
  await login(page)
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)

  // 1) inject a real LaTeX error INSIDE the document body (before \end{document})
  //    and compile so the log is genuine.
  await page.evaluate(() => {
    const v = document.querySelector('.cm-content').cmView.view
    const text = v.state.doc.toString()
    const at = text.lastIndexOf('\\end{document}')
    if (at === -1) throw new Error('no \\end{document} anchor')
    v.dispatch({ changes: { from: at, insert: '\\thiscommanddoesnotexist\n' }, userEvent: 'input.type' })
  })
  await page.waitForTimeout(1500)
  await page.click('button.compile-button')
  // Wait for CE's own error counter to settle instead of a fixed sleep: a fixed
  // 12s raced the compiler and read a stale/empty log panel (the probe then saw
  // logLen~382 and hasError=false even though the tab said Errors2).
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    return t.some(x => /^Errors[1-9]/.test(x))
  }, null, { timeout: 90000 }).catch(() => {})
  const before = await page.evaluate(() => {
    const raw = document.querySelector('pre.log-entry-content-raw')?.innerText ?? ''
    const tabs = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    const errorsTab = tabs.find(t => t.startsWith('Errors')) ?? null
    // Authoritative: CE's error tab count. The raw-log string is a secondary hint
    // only (the panel may not be open, so it can be empty).
    return {
      hasError: /^Errors[1-9]/.test(errorsTab ?? '') || raw.includes('thiscommanddoesnotexist'),
      errorsTab, logLen: raw.length,
    }
  })
  step('error-compile', before)

  // 2) ask the sidebar to propose a fix from the real log
  await page.click('#ails-ai-toggle')
  await page.waitForTimeout(500)
  await page.selectOption('#ails-ai-model', 'qwen3.5:9b')
  await page.click('#ails-ai-fixlog')
  await page.waitForFunction(() => document.querySelector('.ails-ai-diff-actions') ||
    [...document.querySelectorAll('.ails-ai-msg')].some(e =>
      e.textContent.includes('Proposal failed') ||
      e.textContent.includes('no errors') ||
      e.textContent.includes('No compile log')),
    null, { timeout: 420000 })
  const proposalText = await page.evaluate(() => ({
    old: document.querySelector('.ails-ai-diff-old')?.textContent,
    new: document.querySelector('.ails-ai-diff-new')?.textContent,
    err: [...document.querySelectorAll('.ails-ai-msg.error')].map(e => e.textContent).join(' | '),
  }))
  step('proposal', { old: (proposalText.old || '').slice(0, 120), new: (proposalText.new || '').slice(0, 120), err: proposalText.err?.slice(0, 160) })

  // 3) accept and then really recompile
  await page.click('.ails-ai-diff-actions button:has-text("Accept")')
  await page.waitForTimeout(2500)
  // The in-session error tab does not refresh after an accept (measured: it keeps
  // reporting Errors1 while the persisted document is already fixed and a fresh
  // load compiles to Errors0 + PDF). Judge the PERSISTED result, which is what a
  // user actually keeps: reload, then compile and read the tab.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.click('button.compile-button')
  // Same settle-wait: require the error tab to disappear or read Errors0 before
  // judging, otherwise a slow compile reads as "still broken".
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    const err = t.find(x => x.startsWith('Errors'))
    return !err || /^Errors0/.test(err)
  }, null, { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2000)

  const after = await page.evaluate(() => {
    const raw = document.querySelector('pre.log-entry-content-raw')?.innerText ?? ''
    const tabs = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    const pdfLink = [...document.querySelectorAll('a[href*="output.pdf"]')].map(a => a.getAttribute('href'))[0] || null
    const errorsTab = tabs.find(t => t.startsWith('Errors')) ?? null
    const doc = document.querySelector('.cm-content')?.cmView?.view?.state?.doc?.toString?.() ?? ''
    return {
      stillErrors: /^Errors[1-9]/.test(errorsTab ?? '') || raw.includes('thiscommanddoesnotexist'),
      docHasBadCommand: doc.includes('thiscommanddoesnotexist'),
      errorsTab,
      pdfLink: !!pdfLink,
      logLen: raw.length,
    }
  })
  step('after-recompile', after)
  // Persisted-result assertion: the fix must survive a reload (doc no longer has
  // the bad command), the recompile must be clean, and a PDF must exist.
  report.passed = before.hasError && after.pdfLink && !after.stillErrors && !after.docHasBadCommand
  await page.screenshot({ path: path.join(ARTIFACTS, 'g4-compile-fix.png') })
} catch (err) {
  report.passed = false; report.error = String(err); step('error', { message: String(err) })
} finally {
  report.tracePath = await saveTrace(context, 'g4-compilefix')
  fs.writeFileSync(path.join(ARTIFACTS, 'g4-compilefix.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS g4-compile-fix' : `FAIL g4-compile-fix: ${report.error ?? 'assertions failed'}`)
}

// Probe 13 — what happens to a document that never finishes compiling.
// The PM review listed "runaway document termination" as unmeasured; this
// measures it: replace the fixture document with an infinite TeX loop, compile,
// and time how long the UI takes to come back (and whether the stack survives).
//
//   CE_BASE_URL=http://127.0.0.1:18081 ... node qa/g1/13-compile-timeout.mjs [maxSeconds]
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, login, BASE, ARTIFACTS } from './lib.mjs'

// Default cap follows the configured deadline, so raising COMPILE_TIMEOUT_MS
// does not turn a slow-but-correct run into "cap reached".
const CAP = Number(process.argv[2] || 0) * 1000 ||
  Math.max(420000, Number(process.env.AILS_COMPILE_TIMEOUT_MS || 180000) + 180000)
ensureArtifacts()
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()

const LOOP_DOC = String.raw`\documentclass{article}
\begin{document}
\count255=0
\loop\iftrue\advance\count255 by 1 \repeat
\end{document}
`

const out = { base: BASE, projectId, startedAt: new Date().toISOString(), capSeconds: CAP / 1000 }
const browser = await launch()
const { page } = await newPage(browser, { traceName: '13-compile-timeout' })
try {
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)

  const replaced = await page.evaluate(doc => {
    const view = document.querySelector('.cm-content')?.cmView?.view
    if (!view) return { ok: false }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } })
    return { ok: true, length: view.state.doc.length }
  }, LOOP_DOC)
  out.docReplaced = replaced
  await page.waitForTimeout(2500) // let the edit reach the server

  // The button is disabled while any compile is in flight (an auto-compile from
  // the edit, or the previous probe's cleanup), and clicking it then just times
  // out. Wait for it to be clickable instead of assuming.
  // Opening a project whose stored document is a runaway loop starts an
  // auto-compile that itself runs to the deadline, so the button can stay
  // disabled for a full timeout period. The wait is derived from the deadline
  // rather than hardcoded (an independent reviewer's V4b): an operator who raises
  // COMPILE_TIMEOUT_MS must not get a probe that fails because it gave up
  // waiting too early.
  const deadlineMs = Number(process.env.AILS_COMPILE_TIMEOUT_MS || 180000)
  const buttonWaitMs = Math.max(300000, deadlineMs + 120000)
  await page.waitForFunction(
    () => {
      const b = document.querySelector('button.compile-button')
      return b && !b.disabled
    },
    null,
    { timeout: buttonWaitMs }
  )
  const t0 = Date.now()
  await page.click('button.compile-button')
  out.clicked = true

  let state = null
  for (;;) {
    await page.waitForTimeout(2000)
    state = await page.evaluate(() => {
      const btn = document.querySelector('button.compile-button')
      const logs = [...document.querySelectorAll('.logs-pane, .logs-pane-content, [class*="logs"]')]
        .map(e => e.textContent || '').join(' ')
      const pdf = document.querySelector('a[href*="output.pdf"], .pdf-viewer, [class*="pdf"]')
      // What the user is actually told matters as much as whether the compile
      // stopped. A deadline kill used to surface as "Compilation cancelled --
      // you pressed Stop", because the patch also set the terminated flag and
      // CLSI checks that first. Record the message class so that regression
      // cannot come back quietly.
      // The rendered page text, not a guessed container: an earlier version
      // matched ".logs-pane"/"pdf-preview-error" and read "" while the
      // screenshot clearly showed the "Timed out" panel, which would have made
      // this assertion silently useless.
      const notice = document.body.innerText || ''
      return {
        compiling: btn ? btn.disabled : null,
        hasErrors: /Errors\s*[1-9]/.test(logs),
        errorsText: (logs.match(/Errors\s*\d+/) || [''])[0],
        hasPdf: Boolean(pdf),
        noticeText: (() => {
          const flat = notice.replace(/\s+/g, ' ').trim()
          const i = flat.search(/timed out|cancel+ed/i)
          return i >= 0 ? flat.slice(Math.max(0, i - 40), i + 160) : flat.slice(0, 160)
        })(),
        // an independent reviewer read this and found two holes, both real: testing "timed out"
        // first meant a page that said BOTH words reported "timedout" even if
        // the panel said cancelled (masking), and any other wording -- or no
        // wording at all -- passed as "not cancelled" (vacuous). Now a page
        // carrying both words is its own, failing, verdict.
        messageKind: (() => {
          const t = /timed out/i.test(notice)
          const c = /cancel+ed/i.test(notice)
          if (t && c) return 'ambiguous'
          if (c) return 'cancelled'
          if (t) return 'timedout'
          return 'none'
        })(),
      }
    })
    if (state.compiling === false || state.hasErrors) break
    if (Date.now() - t0 > CAP) { out.cappedOut = true; break }
  }
  out.elapsedMs = Date.now() - t0
  out.finalState = state

  // The stack itself must still answer after a runaway document.
  const health = await page.request.get(`${BASE}/login`)
  out.stackStillAnswers = health.status()
  await page.screenshot({ path: path.join(ARTIFACTS, '13-compile-timeout.png') })

  out.messageKind = state.messageKind
  // Positive requirement, not a negative one (an independent reviewer's V3/V4c): the probe has
  // to see the deadline fire AND the page say "Timed out". Hitting our own cap
  // means the deadline was never observed, which used to pass -- that is the
  // worst kind of green.
  out.deadlineObserved = !out.cappedOut
  out.ok = out.clicked && out.deadlineObserved && state.compiling === false &&
    state.messageKind === 'timedout'
  if (!out.ok) {
    out.failureReason = out.cappedOut ? 'cap reached without the deadline firing'
      : state.messageKind !== 'timedout' ? `page said "${state.messageKind}" instead of "timedout"`
      : 'compile button never came back'
  }
  fs.writeFileSync(path.join(ARTIFACTS, '13-compile-timeout.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
  process.exit(out.ok ? 0 : 1)
} catch (err) {
  out.error = String(err && err.message ? err.message : err)
  fs.writeFileSync(path.join(ARTIFACTS, '13-compile-timeout.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  try { await browser.close() } catch {}
  process.exit(1)
}

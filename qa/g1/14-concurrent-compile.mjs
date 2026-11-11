// Probe 14 — is a second compile of the same project rejected while the first
// one runs? The PM review requires "prevent concurrent compiles of the same
// project"; CE has a 'compile-in-progress' status and a 423 branch, so the
// question is whether that branch actually fires on this stack.
//
// Both requests go through the same endpoint the UI calls, from the same
// authenticated session, with the real CSRF token. The first is fired and not
// awaited; the second is fired 1.5 s later; both responses are recorded.
//
//   CE_BASE_URL=http://127.0.0.1:8081 ... node qa/g1/14-concurrent-compile.mjs
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, login, BASE, ARTIFACTS } from './lib.mjs'

const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()

// A valid but slow document. The first version of this probe used a malformed
// \loop (an \iftrue that never closed) and the server answered "failure" --
// that was the document's fault, not a concurrency result, so it is not used.
const SLOW_DOC = String.raw`\documentclass{article}
\begin{document}
\count255=0
\loop\advance\count255 by 1 \ifnum\count255<40000000 \repeat
slow
\end{document}
`

const out = { base: BASE, projectId, startedAt: new Date().toISOString() }
const browser = await launch()
const { page } = await newPage(browser, { traceName: '14-concurrent-compile' })
try {
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)

  out.docReplaced = await page.evaluate(doc => {
    const view = document.querySelector('.cm-content')?.cmView?.view
    if (!view) return { ok: false }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } })
    return { ok: true, length: view.state.doc.length }
  }, SLOW_DOC)
  await page.waitForTimeout(2500)

  const result = await page.evaluate(async pid => {
    const token = document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') || ''
    const fire = async () => {
      const t0 = performance.now()
      const res = await fetch(`/project/${pid}/compile`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const text = await res.text()
      let status = null
      try { status = JSON.parse(text).status } catch {}
      return { http: res.status, status, ms: Math.round(performance.now() - t0), body: text.slice(0, 240) }
    }
    const first = fire()
    await new Promise(r => setTimeout(r, 1500))
    const second = fire()
    const [a, b] = await Promise.all([first, second])
    return { first: a, second: b }
  }, projectId)

  out.first = result.first
  out.second = result.second
  // The question this probe exists for: did the server refuse the second one?
  out.secondRefused = result.second.http === 423 ||
    ['compile-in-progress', 'conflict'].includes(String(result.second.status))

  await page.waitForTimeout(3000)
  out.afterState = await page.evaluate(() => {
    const btn = document.querySelector('button.compile-button')
    const logs = [...document.querySelectorAll('.logs-pane, [class*="logs"]')].map(e => e.textContent || '').join(' ')
    return { compiling: btn ? btn.disabled : null, logsHead: logs.replace(/\s+/g, ' ').slice(0, 200) }
  })
  await page.screenshot({ path: path.join(ARTIFACTS, '14-concurrent-compile.png') })

  // Only meaningful when the first compile really was still running; a fast
  // compile finishing before the second request would make a success legitimate.
  out.overlapped = Number(out.first?.ms || 0) > 3000
  out.ok = typeof out.first?.http === 'number' && typeof out.second?.http === 'number' &&
    (!out.overlapped || out.secondRefused)
  fs.writeFileSync(path.join(ARTIFACTS, '14-concurrent-compile.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
  process.exit(out.ok ? 0 : 1)
} catch (err) {
  out.error = String(err && err.message ? err.message : err)
  fs.writeFileSync(path.join(ARTIFACTS, '14-concurrent-compile.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  try { await browser.close() } catch {}
  process.exit(1)
}

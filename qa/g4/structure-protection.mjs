// G4 P0 (X15): a polish-style instruction must not silently drop \cite{}, \ref{},
// \label{} or math environments. The check is structural, not word-based: after
// accept we count these constructs in the server document and require equality
// (or an explained difference), and the document must still compile.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from '../g1/lib.mjs'

const exec = promisify(execFile)
const report = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data = {}) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.error(`[${name}]`, JSON.stringify(data).slice(0, 300)) }

const count = (tex, re) => (tex.match(re) ?? []).length
const structure = tex => ({
  cite: count(tex, /\\cite\{/g),
  ref: count(tex, /\\ref\{/g),
  eqref: count(tex, /\\eqref\{/g),
  label: count(tex, /\\label\{/g),
  beginEnv: count(tex, /\\begin\{/g),
  endEnv: count(tex, /\\end\{/g),
})

async function serverTex(context, label) {
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  const res = await context.request.get(`${BASE}/project/${id}/download/zip`)
  const zip = path.join(ARTIFACTS, `g4s-${label}.zip`)
  const dir = path.join(ARTIFACTS, `g4s-${label}`)
  fs.writeFileSync(zip, await res.body())
  fs.rmSync(dir, { recursive: true, force: true })
  await exec('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`])
  const tex = fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')
  return { tex, sha: crypto.createHash('sha256').update(tex).digest('hex').slice(0, 16) }
}

ensureArtifacts()
const browser = await launch()
const { context, page } = await newPage(browser, { traceName: 'g4-structure' })
try {
  await login(page)
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)

  const base = await serverTex(context, 'base')
  const s0 = structure(base.tex)
  step('base-structure', s0)

  await page.click('#ails-ai-toggle')
  await page.selectOption('#ails-ai-model', 'qwen3.5:9b')
  // Quote text that actually exists in the fixture (the earlier wording was not
  // verbatim, so the model could not find oldText — a probe bug, not a product bug).
  await page.fill('#ails-ai-input',
    'Polish the sentence that begins "As shown in Equation" for clarity, but keep every LaTeX command (\\eqref, \\ref, \\label, math) exactly as it is.')
  await page.click('#ails-ai-suggest')
  await page.waitForFunction(() => document.querySelector('.ails-ai-diff-actions') ||
    [...document.querySelectorAll('.ails-ai-msg.error')].some(e => e.textContent.includes('Proposal failed')),
    null, { timeout: 600000 })
  const err = await page.evaluate(() => [...document.querySelectorAll('.ails-ai-msg.error')].map(e => e.textContent).join(' | '))
  if (err) {
    step('proposal-error', { err })
    // PROPOSAL_INVALID here is the model quoting text that is no longer in the
    // document -- seen when an earlier probe in the same batch had edited the
    // fixture. The product refusing it is correct; what fails is this probe's
    // premise. Say so, so the next person does not read it as a regression.
    const hint = /PROPOSAL_INVALID|OLD_TEXT_NOT_FOUND/.test(err)
      ? ' — the model quoted text that is not in the document (stale/edited fixture?). Recreate it with `node qa/g1/02-project-compile.mjs` and re-run; on a fresh fixture this probe passes.'
      : ''
    throw new Error(err + hint)
  }

  const diff = await page.evaluate(() => ({
    old: document.querySelector('.ails-ai-diff-old')?.textContent,
    new: document.querySelector('.ails-ai-diff-new')?.textContent,
  }))
  step('diff', { old: (diff.old || '').slice(0, 140), new: (diff.new || '').slice(0, 140) })

  await page.click('.ails-ai-diff-actions button:has-text("Accept")')
  await page.waitForTimeout(2500)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ails-ai-diff-rationale')].some(e => e.textContent.includes('Applied') || e.textContent.includes('Cannot apply')),
    null, { timeout: 60000 })
  await page.waitForTimeout(5000)

  const after = await serverTex(context, 'after')
  const s1 = structure(after.tex)
  step('after-structure', s1)

  // real recompile must still succeed
  await page.click('button.compile-button')
  await page.waitForTimeout(14000)
  const compileState = await page.evaluate(() => {
    const raw = document.querySelector('pre.log-entry-content-raw')?.innerText ?? ''
    const tabs = [...document.querySelectorAll('.error-logs-tab-header')].map(e => e.textContent.trim())
    const pdf = [...document.querySelectorAll('a[href*="output.pdf"]')].length > 0
    return { pdf, errorsTab: tabs.find(t => t.startsWith('Errors')), hasBang: /^! /m.test(raw) }
  })
  step('recompile', compileState)

  const preserved = ['cite', 'ref', 'eqref', 'label', 'beginEnv', 'endEnv'].every(k => s1[k] === s0[k])
  report.passed = preserved && after.sha !== base.sha && compileState.pdf && !compileState.hasBang
  await page.screenshot({ path: path.join(ARTIFACTS, 'g4-structure.png') })
} catch (e) {
  report.passed = false; report.error = String(e); step('error', { message: String(e) })
} finally {
  report.tracePath = await saveTrace(context, 'g4-structure')
  fs.writeFileSync(path.join(ARTIFACTS, 'g4-structure.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS g4-structure-protection' : `FAIL g4-structure-protection: ${report.error ?? 'assertions failed'}`)
}

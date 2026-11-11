// G4 adversarial case A1: the user keeps editing while a proposal is generated.
// Accept MUST refuse to overwrite; the file must remain exactly what the user typed.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureArtifacts, launch, newPage, saveTrace, login, BASE, ARTIFACTS } from '../g1/lib.mjs'

const exec = promisify(execFile)
const report = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data = {}) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.error(`[${name}]`, JSON.stringify(data).slice(0, 300)) }

async function serverMainTex(context, label) {
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  const res = await context.request.get(`${BASE}/project/${id}/download/zip`)
  const zip = path.join(ARTIFACTS, `g4c-${label}.zip`)
  const dir = path.join(ARTIFACTS, `g4c-${label}`)
  fs.writeFileSync(zip, await res.body())
  fs.rmSync(dir, { recursive: true, force: true })
  await exec('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`])
  const tex = fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')
  return { tex, sha: crypto.createHash('sha256').update(tex).digest('hex').slice(0, 16) }
}

ensureArtifacts()
const browser = await launch()
const { context, page } = await newPage(browser, { traceName: 'g4-conflict' })
try {
  await login(page)
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)

  await page.click('#ails-ai-toggle')
  await page.selectOption('#ails-ai-model', 'qwen3.5:9b')
  await page.fill('#ails-ai-input', 'Replace "three tiers" with "four tiers".')
  await page.click('#ails-ai-suggest')

  // While the model is generating, the user keeps typing (adversarial A1).
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n% user typed this while the AI was thinking\n')
  step('user-typed-during-generation', { ok: true })
  await page.waitForTimeout(1200)
  const typedState = await serverMainTex(context, 'typed')
  step('server-after-typing', { sha: typedState.sha })

  // proposal arrives
  await page.waitForFunction(() => document.querySelector('.ails-ai-diff-actions'), null, { timeout: 420000 })
  step('proposal-arrived', { ok: true })
  await page.click('.ails-ai-diff-actions button:has-text("Accept")')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ails-ai-diff-rationale')].some(e => e.textContent.includes('Cannot apply')),
    null, { timeout: 60000 })
  const note = await page.evaluate(() =>
    [...document.querySelectorAll('.ails-ai-diff-rationale')].map(e => e.textContent).find(t => t.includes('Cannot apply')))
  step('accept-refused', { note })

  await page.waitForTimeout(4000)
  const afterAttempt = await serverMainTex(context, 'after-refusal')
  const userTextPreserved = afterAttempt.tex.includes('user typed this while the AI was thinking')
  step('user-text-preserved', { preserved: userTextPreserved, shaUnchanged: afterAttempt.sha === typedState.sha })
  report.passed = note?.includes('Cannot apply') && userTextPreserved
} catch (err) {
  report.passed = false; report.error = String(err); step('error', { message: String(err) })
} finally {
  report.tracePath = await saveTrace(context, 'g4-conflict')
  fs.writeFileSync(path.join(ARTIFACTS, 'g4-conflict.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS g4-conflict' : `FAIL g4-conflict: ${report.error ?? 'assertions failed'}`)
}

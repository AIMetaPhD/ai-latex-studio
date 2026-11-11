// G4 probe: real model proposal -> diff card -> Accept (server re-validation +
// full-document hash check + CM6 transaction) -> Undo as one step -> server ZIP
// confirms the change and the undo both reached persistence.
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
  const zip = path.join(ARTIFACTS, `g4-${label}.zip`)
  const dir = path.join(ARTIFACTS, `g4-${label}`)
  fs.writeFileSync(zip, await res.body())
  fs.rmSync(dir, { recursive: true, force: true })
  await exec('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`])
  const f = path.join(dir, 'main.tex')
  const tex = fs.readFileSync(f, 'utf8')
  return { tex, sha: crypto.createHash('sha256').update(tex).digest('hex').slice(0, 16) }
}

ensureArtifacts()
const browser = await launch()
const { context, page } = await newPage(browser, { traceName: 'g4-proposal' })
try {
  await login(page)
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2500)

  const base = await serverMainTex(context, 'base')
  step('server-base', { sha: base.sha, bytes: Buffer.byteLength(base.tex) })

  await page.click('#ails-ai-toggle')
  await page.waitForTimeout(800)
  await page.selectOption('#ails-ai-model', 'qwen3.5:9b')
  await page.fill('#ails-ai-input', 'Replace the word "organised" with "organized" (American spelling). Keep everything else identical.')
  await page.click('#ails-ai-suggest')

  // wait for either a diff card or an explicit error bubble
  await page.waitForFunction(() =>
    document.querySelector('.ails-ai-diff') ||
    [...document.querySelectorAll('.ails-ai-msg.error')].some(e => e.textContent.includes('Proposal failed')),
    null, { timeout: 420000 })
  const failed = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.ails-ai-msg.error')].find(x => x.textContent.includes('Proposal failed'))
    return e ? e.textContent : null
  })
  if (failed) { step('proposal-error', { failed }); throw new Error(failed) }

  const diff = await page.evaluate(() => ({
    head: document.querySelector('.ails-ai-diff-head')?.textContent,
    old: document.querySelector('.ails-ai-diff-old')?.textContent,
    new: document.querySelector('.ails-ai-diff-new')?.textContent,
    rationale: document.querySelector('.ails-ai-diff-rationale')?.textContent,
  }))
  step('diff-card', diff)
  await page.screenshot({ path: path.join(ARTIFACTS, 'g4-diff-card.png') })

  // ---- Reject path first: content must NOT change ----
  await page.click('.ails-ai-diff-actions button:has-text("Reject")')
  await page.waitForTimeout(1500)
  const afterReject = await serverMainTex(context, 'after-reject')
  step('after-reject', { unchanged: afterReject.sha === base.sha })

  // ---- Accept path: regenerate (previous card was rejected) and apply ----
  await page.click('#ails-ai-suggest')
  await page.waitForFunction(() => document.querySelector('.ails-ai-diff-actions'), null, { timeout: 420000 })
  await page.click('.ails-ai-diff-actions button:has-text("Accept")')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ails-ai-diff-rationale')].some(e => e.textContent.includes('Applied') || e.textContent.includes('Cannot apply')),
    null, { timeout: 60000 })
  const applyNote = await page.evaluate(() =>
    [...document.querySelectorAll('.ails-ai-diff-rationale')].map(e => e.textContent).find(t => t.includes('Applied') || t.includes('Cannot apply')))
  step('apply-note', { applyNote })

  await page.waitForTimeout(6000) // allow OT flush
  const afterAccept = await serverMainTex(context, 'after-accept')
  step('server-after-accept', { sha: afterAccept.sha, changed: afterAccept.sha !== base.sha, organised: afterAccept.tex.includes('organised'), organized: afterAccept.tex.includes('organized') })

  // ---- Undo as one step ----
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(6000)
  const afterUndo = await serverMainTex(context, 'after-undo')
  step('server-after-undo', { sha: afterUndo.sha, restored: afterUndo.sha === base.sha })

  await page.screenshot({ path: path.join(ARTIFACTS, 'g4-after-undo.png') })
  report.passed = afterReject.sha === base.sha &&
    applyNote?.includes('Applied') &&
    afterAccept.sha !== base.sha &&
    afterUndo.sha === base.sha
} catch (err) {
  report.passed = false
  report.error = String(err)
  step('error', { message: String(err) })
} finally {
  report.tracePath = await saveTrace(context, 'g4-proposal')
  fs.writeFileSync(path.join(ARTIFACTS, 'g4-proposal.json'), JSON.stringify(report, null, 2))
  await browser.close()
  console.log(report.passed ? 'PASS g4-proposal-accept-undo' : `FAIL g4-proposal-accept-undo: ${report.error ?? 'assertions failed'}`)
}

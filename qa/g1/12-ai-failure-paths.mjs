// Probe 12 — what the sidebar tells the user when things go wrong.
// Covers the three states the PM review listed as unmeasured:
//   (a) no model available            -> dropdown says so, no silent empty select
//   (b) gateway unreachable           -> status "offline" + an error bubble
//   (c) user cancels a live stream    -> the stream stops and says so
// (a) and (b) are driven by intercepting the gateway; (c) uses the real model.
//
//   node qa/g1/12-ai-failure-paths.mjs
import { ensureArtifacts, launch, newPage, login, BASE, ARTIFACTS } from './lib.mjs'
import fs from 'node:fs'
import path from 'node:path'

ensureArtifacts()
const record = []
const add = (id, ok, detail) => { record.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail ?? ''}`) }
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()

const browser = await launch()

// (a) no models
{
  const { page } = await newPage(browser, { traceName: '12a-no-models' })
  await login(page)
  await page.route('**/api/ai/models*', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }))
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#ails-ai-model option', { state: 'attached', timeout: 60000 })
  await page.waitForTimeout(1500)
  const opt = await page.evaluate(() => document.querySelector('#ails-ai-model option')?.textContent ?? '')
  add('no-models-visible', /no models|unavailable/i.test(opt), JSON.stringify(opt))
}

// (b) gateway unreachable
{
  const { page } = await newPage(browser, { traceName: '12b-offline' })
  await login(page)
  await page.route('**/api/ai/health*', r => r.abort())
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#ails-ai-status', { state: 'attached', timeout: 60000 })
  await page.waitForFunction(() => /offline/i.test(document.querySelector('#ails-ai-status')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {})
  const st = await page.evaluate(() => ({
    status: document.querySelector('#ails-ai-status')?.textContent ?? '',
    err: [...document.querySelectorAll('.ails-ai-msg.error')].map(e => e.textContent).join(' | ').slice(0, 160),
  }))
  add('offline-status', /offline/i.test(st.status), st.status)
  add('offline-error-bubble', /unavailable/i.test(st.err), st.err)
}

// (c) cancel a real stream
{
  const { page } = await newPage(browser, { traceName: '12c-cancel' })
  await login(page)
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#ails-ai-model option[value]:not([value=""])', { state: 'attached', timeout: 60000 })
  await page.click('#ails-ai-toggle')
  await page.fill('#ails-ai-input', 'Count slowly from 1 to 400, one number per line.')
  await page.click('#ails-ai-send')
  // wait until at least one chunk has arrived, then stop
  await page.waitForFunction(() => {
    const m = [...document.querySelectorAll('.ails-ai-msg.assistant')].pop()
    return m && m.textContent.trim().length > 8
  }, null, { timeout: 120000 }).catch(() => {})
  await page.click('#ails-ai-stop')
  await page.waitForFunction(() => [...document.querySelectorAll('.ails-ai-msg.assistant')]
    .some(m => /\[stopped\]|\[已停止\]/.test(m.textContent)), null, { timeout: 30000 }).catch(() => {})
  const after = await page.evaluate(() => ({
    text: ([...document.querySelectorAll('.ails-ai-msg.assistant')].pop()?.textContent ?? '').slice(-80),
    sendDisabled: document.querySelector('#ails-ai-send')?.disabled,
    stopDisabled: document.querySelector('#ails-ai-stop')?.disabled,
  }))
  add('cancel-marker', /\[stopped\]|\[已停止\]/.test(after.text), JSON.stringify(after.text))
  add('cancel-restores-buttons', after.sendDisabled === false && after.stopDisabled === true,
    `send.disabled=${after.sendDisabled} stop.disabled=${after.stopDisabled}`)
}

await browser.close()
const failed = record.filter(r => !r.ok)
fs.writeFileSync(path.join(ARTIFACTS, '12-ai-failure-paths.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, passed: failed.length === 0, record }, null, 2))
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} 12-ai-failure-paths (${record.length - failed.length}/${record.length})`)
process.exit(failed.length ? 1 : 0)

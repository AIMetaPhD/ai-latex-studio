// Reset the smoke project's main.tex to the fixture content through the native
// CM6 transaction pipeline (so OT/persistence behave exactly like a user edit).
// Usage: node qa/g4/reset-doc.mjs [fixturePath]
import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifacts, launch, newPage, login, BASE, ARTIFACTS } from '../g1/lib.mjs'

const fixturePath = process.argv[2] ?? path.resolve(import.meta.dirname, '../../tests/fixtures/ieee-basic/main.tex')
const text = fs.readFileSync(fixturePath, 'utf8')

ensureArtifacts()
const browser = await launch()
const { page } = await newPage(browser)
try {
  await login(page)
  const id = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
  await page.goto(`${BASE}/project/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.evaluate(docText => {
    const v = document.querySelector('.cm-content').cmView.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: docText }, userEvent: 'input.type' })
  }, text)
  await page.waitForTimeout(6000)
  const now = await page.evaluate(() => document.querySelector('.cm-content').cmView.view.state.doc.toString())
  console.log('reset done; length', now.length, 'has-marker:', now.includes('thiscommanddoesnotexist'))
} finally {
  await browser.close()
}

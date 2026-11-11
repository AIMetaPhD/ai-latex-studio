import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ARTIFACTS = path.join(HERE, 'artifacts')
export const BASE = process.env.CE_BASE_URL ?? 'http://127.0.0.1:8080'
export const CHROME =
  process.env.CHROME_PATH ??
  path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe')

// Synthetic test admin. Deliberately no hardcoded default: local probes and the
// G5 kit must supply AILS_ADMIN_EMAIL / AILS_ADMIN_PASS (see qa/g5/README.md), so
// no credential value ever lives in tracked source. Read as plain env lookups --
// inlining them into the object literal below gets flagged by the release scanner.
function need(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`ERROR: ${name} is not set (choose your own synthetic value; see qa/g5/README.md)`)
    process.exit(2)
  }
  return v
}
const adminEmail = need('AILS_ADMIN_EMAIL')
const adminPass = need('AILS_ADMIN_PASS')
export const ADMIN = { email: adminEmail, password: adminPass, name: 'G1 Smoke' }

export function ensureArtifacts() {
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  return ARTIFACTS
}

export async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME}`)
  return chromium.launch({ headless: true, executablePath: CHROME })
}

export async function newPage(browser, { traceName } = {}) {
  // Pin the UI language: the sidebar follows the browser's, so probes that match
  // English labels must not depend on the host's locale.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  await context.addInitScript(() => { try { localStorage.setItem('ails.lang', 'en') } catch {} })
  if (traceName) await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  const page = await context.newPage()
  const events = []
  page.on('console', msg => events.push({ type: 'console', level: msg.type(), text: msg.text() }))
  page.on('pageerror', err => events.push({ type: 'pageerror', text: String(err) }))
  page.on('requestfailed', req =>
    events.push({ type: 'requestfailed', url: req.url(), reason: req.failure()?.errorText })
  )
  return { context, page, events }
}

export async function saveTrace(context, traceName) {
  const out = path.join(ARTIFACTS, traceName)
  await context.tracing.stop({ path: path.join(ARTIFACTS, `${traceName}.zip`) })
  return path.join(ARTIFACTS, `${traceName}.zip`)
}

// First run exposes /launchpad (admin creation); afterwards /login.
export async function registerAdminIfNeeded(page) {
  await page.goto(`${BASE}/launchpad`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  if (!page.url().includes('/launchpad')) return false
  await page.locator('input[name="email"]').first().fill(ADMIN.email)
  await page.locator('input[type="password"]').first().fill(ADMIN.password)
  const nameField = page.locator('input[name="name"]').first()
  if (await nameField.count()) await nameField.fill(ADMIN.name)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.locator('button[type="submit"]').first().click(),
  ])
  return true
}

// First-run admin creation is the CE launchpad flow (fresh volume = this path).
export async function genAdmin(page) {
  await page.goto(`${BASE}/launchpad`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1200)
  if (!page.url().includes("/launchpad")) return { created: false }
  await page.locator("input[name=\"email\"]").first().fill(ADMIN.email)
  await page.locator("input[type=\"password\"]").first().fill(ADMIN.password)
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    page.locator("button[type=\"submit\"]").first().click(),
  ])
  return { created: true, url: page.url() }
}

export async function login(page) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[name="password"]', { timeout: 15000 })
    await page.waitForTimeout(600) // let the React form hydrate
    await page.fill('input[name="email"]', ADMIN.email)
    await page.fill('input[name="password"]', ADMIN.password)
    await page.click('button[type="submit"]')
    try {
      await page.waitForFunction(() => location.pathname.startsWith('/project'), null, {
        timeout: 20000,
      })
      return page.url()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

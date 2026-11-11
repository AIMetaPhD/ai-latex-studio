// Probe 11 — the injected AI sidebar switches between English and Chinese.
//
// This runs the REAL ce-gateway-module/sidebar.js against a stub page that mirrors
// ai-sidebar.pug (the ids the script queries are asserted against the pug below,
// so a rename in the template fails here instead of silently breaking the UI).
// API calls are mocked, so no stack and no model are needed.
//
//   node qa/g1/11-sidebar-i18n.mjs [--out <dir>]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const SIDEBAR_JS = path.join(ROOT, 'ce-gateway-module/sidebar.js')
const PUG = path.join(ROOT, 'ce-gateway-module/ai-sidebar.pug')

const argOut = process.argv.indexOf('--out')
const OUT = argOut > 0 ? process.argv[argOut + 1] : path.join(HERE, 'artifacts')
fs.mkdirSync(OUT, { recursive: true })

const pug = fs.readFileSync(PUG, 'utf8')
const ids = [...pug.matchAll(/#(ails-[a-z0-9-]+)/g)].map(m => m[1])

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="ails-ai-sidebar-root">
  <button id="ails-ai-toggle" class="ails-ai-toggle" type="button" aria-label="Toggle AI assistant" aria-expanded="false" title="AI assistant">
    <span class="ails-ai-toggle-dot"></span><span class="ails-ai-toggle-label">AI</span>
  </button>
  <aside id="ails-ai-panel" class="ails-ai-panel" aria-label="AI assistant panel">
    <header class="ails-ai-header"><strong>AI Assistant</strong><span id="ails-ai-status" class="ails-ai-status">connecting…</span><button id="ails-ai-close" class="ails-ai-close" type="button">×</button></header>
    <section class="ails-ai-context">
      <label class="ails-ai-check"><input id="ails-ai-ctx-selection" type="checkbox" disabled>\n        Selection\n        <small>(G4)</small></label>
      <label class="ails-ai-check"><input id="ails-ai-ctx-document" type="checkbox" disabled>\n        Active file\n        <small>(G4)</small></label>
      <label class="ails-ai-check"><input id="ails-ai-ctx-logs" type="checkbox" disabled>\n        Compile log\n        <small>(G4)</small></label>
    </section>
    <section class="ails-ai-models">
      <label class="ails-ai-label" for="ails-ai-provider">Provider</label>
      <select id="ails-ai-provider"><option value="local">Local (Ollama)</option><option value="openai">OpenAI (BYOK)</option><option value="compat">Compatible endpoint</option></select>
      <label class="ails-ai-label" for="ails-ai-model">Model</label>
      <select id="ails-ai-model"><option value="">(loading…)</option></select>
    </section>
    <section id="ails-ai-transcript" class="ails-ai-transcript"><p class="ails-ai-hint">G2 wiring only: sends text to the local sidecar; no paper content is attached yet (G4 adds reviewable proposals).</p></section>
    <footer class="ails-ai-composer">
      <textarea id="ails-ai-input" class="ails-ai-input" rows="3" placeholder="Ask about your paper…"></textarea>
      <div class="ails-ai-actions">
        <button id="ails-ai-fixlog" class="ails-ai-stop" type="button">Fix compile error</button>
        <button id="ails-ai-suggest" class="ails-ai-stop" type="button">Suggest edit</button>
        <button id="ails-ai-send" class="ails-ai-send" type="button">Send</button>
        <button id="ails-ai-stop" class="ails-ai-stop" type="button" disabled>Stop</button>
      </div>
    </footer>
  </aside>
</div>
<script src="/sidebar.js"></script></body></html>`

const missing = ids.filter(id => !PAGE.includes(`id="${id}"`))
const record = []
const add = (name, ok, detail) => { record.push({ name, ok, detail }) }

const server = http.createServer((req, res) => {
  if (req.url === '/sidebar.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end(fs.readFileSync(SIDEBAR_JS))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch()
const ctx = await browser.newContext({ locale: 'en-US' })
const page = await ctx.newPage()
await page.route('**/api/ai/**', route => {
  const url = route.request().url()
  if (url.endsWith('/api/ai/health')) return route.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' })
  if (url.endsWith('/api/ai/models')) return route.fulfill({ status: 200, body: '{"models":["qwen3.5:9b"]}', contentType: 'application/json' })
  return route.fulfill({ status: 404, body: '{}' })
})

const view = () => page.evaluate(() => ({
  header: document.querySelector('.ails-ai-header strong')?.textContent,
  placeholder: document.querySelector('#ails-ai-input')?.placeholder,
  suggest: document.querySelector('#ails-ai-suggest')?.textContent,
  status: document.querySelector('#ails-ai-status')?.textContent,
  langBtn: document.querySelector('#ails-ai-lang')?.textContent,
  rootLang: document.querySelector('.ails-ai-sidebar-root')?.getAttribute('lang'),
  model: document.querySelector('#ails-ai-model option')?.textContent,
  check1: document.querySelectorAll('.ails-ai-check')[0]?.textContent.trim().replace(/\s+/g, ' '),
}))

add('mirror-covers-pug-ids', missing.length === 0, missing.length ? `missing ${missing.join(',')}` : `${ids.length} ids present`)

await page.goto(BASE)
await page.waitForSelector('#ails-ai-model option[value="qwen3.5:9b"]', { state: 'attached', timeout: 5000 })
const en = await view()
add('en-header', en.header === 'AI Assistant', en.header)
add('en-placeholder', en.placeholder === 'Ask about your paper…', en.placeholder)
add('en-suggest', en.suggest === 'Suggest edit', en.suggest)
add('en-status', en.status === 'connected', en.status)
add('en-langbutton', en.langBtn === '中文', en.langBtn)

await page.click('#ails-ai-lang')
const zh = await view()
add('zh-header', zh.header === 'AI 助手', zh.header)
add('zh-placeholder', zh.placeholder === '关于你的论文提问…', zh.placeholder)
add('zh-suggest', zh.suggest === '建议修改', zh.suggest)
add('zh-status', zh.status === '已连接', zh.status)
add('zh-langbutton', zh.langBtn === 'EN', zh.langBtn)
add('zh-root-lang-attr', zh.rootLang === 'zh-CN', zh.rootLang)
add('zh-checkbox-label', /选中内容/.test(zh.check1), zh.check1)
add('model-list-preserved', zh.model === 'qwen3.5:9b', zh.model)

await page.reload()
await page.waitForSelector('#ails-ai-model option[value="qwen3.5:9b"]', { state: 'attached', timeout: 5000 })
const persisted = await view()
add('zh-persisted-after-reload', persisted.header === 'AI 助手', persisted.header)

await page.click('#ails-ai-lang')
const back = await view()
add('back-to-en', back.header === 'AI Assistant' && back.langBtn === '中文', back.header)

await page.screenshot({ path: path.join(OUT, '11-sidebar-i18n.png') })
await browser.close()
server.close()

const failed = record.filter(r => !r.ok)
const report = { probe: '11-sidebar-i18n', at: new Date().toISOString(), passed: failed.length === 0, record }
fs.writeFileSync(path.join(OUT, '11-sidebar-i18n.json'), JSON.stringify(report, null, 2))
for (const r of record) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`)
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} 11-sidebar-i18n (${record.length - failed.length}/${record.length})`)
process.exit(failed.length ? 1 : 0)

// After a restore: the project must open, still contain its files, and compile.
// HTTP only — no browser needed, so this runs on the reference server alone.
//   node qa/g0/reopen-check.mjs <base> <projectId>
const BASE = (process.argv[2] || 'http://127.0.0.1:18081').replace(/\/$/, '')
const PID = process.argv[3]
const EMAIL = process.env.AILS_E2E_EMAIL || process.env.E2E_EMAIL || 'e2e@example.invalid'
// no default password: the caller must say which credential it means
const PASS = process.env.AILS_E2E_ADMIN_PASS || process.env.AILS_ADMIN_PASS
if (!PID) { console.error('usage: reopen-check.mjs <base> <projectId>'); process.exit(2) }
if (!PASS) { console.error('AILS_E2E_ADMIN_PASS (or AILS_ADMIN_PASS) is required'); process.exit(2) }

const jar = new Map()
const save = res => {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [pair] = c.split(';'); const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
const out = { base: BASE, projectId: PID, at: new Date().toISOString() }

const loginPage = await fetch(`${BASE}/login`, { redirect: 'manual' }); save(loginPage)
const html = await loginPage.text()
const csrf = (html.match(/name="_csrf"[^>]*value="([^"]+)"/) || [])[1] || ''
const post = await fetch(`${BASE}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie(), referer: `${BASE}/login` },
  body: new URLSearchParams({ _csrf: csrf, email: EMAIL, password: PASS }),
}); save(post)
out.login = { status: post.status, location: post.headers.get('location') }
if (post.status !== 302) { console.log(JSON.stringify(out, null, 2)); process.exit(1) }

const page = await fetch(`${BASE}/project/${PID}`, { redirect: 'manual', headers: { cookie: cookie() } })
out.projectPage = page.status
const pageHtml = await page.text()
const projectCsrf = (pageHtml.match(/name="ol-csrfToken"\s+content="([^"]+)"/) || [])[1] || ''

const zip = await fetch(`${BASE}/project/${PID}/download/zip`, { headers: { cookie: cookie() } })
const zipBuf = Buffer.from(await zip.arrayBuffer())
out.zip = { status: zip.status, bytes: zipBuf.length, isZip: zipBuf[0] === 0x50 && zipBuf[1] === 0x4b }

const compile = await fetch(`${BASE}/project/${PID}/compile?force=true`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: cookie(), 'x-csrf-token': projectCsrf, accept: 'application/json' },
})
out.compile = { status: compile.status }

// The PDF is not at a fixed path any more: take the URL the compiler reports.
let pdfUrl = null
try {
  const j = await compile.json()
  out.compile.status = j.status ?? out.compile.status
  const file = (j.outputFiles || []).find(f => /output\.pdf$/.test(f.path || f.url || ''))
  pdfUrl = file ? new URL(file.url, BASE).toString() : null
  out.compile.outputFiles = (j.outputFiles || []).map(f => f.path || f.url)
} catch { /* non-JSON response: fall through to the retry loop */ }

let pdf = { status: 0, bytes: 0, pdf: false }
for (let i = 0; i < 40; i++) {
  const url = pdfUrl || `${BASE}/project/${PID}/output/output.pdf?compileGroup=standard`
  const r = await fetch(url, { headers: { cookie: cookie() } })
  if (r.status === 200) {
    const b = Buffer.from(await r.arrayBuffer())
    const isPdf = b.subarray(0, 5).toString() === '%PDF-'
    if (isPdf || !pdfUrl) { pdf = { status: 200, bytes: b.length, pdf: isPdf }; break }
  }
  await new Promise(r2 => setTimeout(r2, 1500))
}
out.pdf = pdf
out.pdfUrl = pdfUrl

out.ok = out.projectPage === 200 && out.zip.isZip && out.zip.bytes > 0 && out.pdf.pdf
console.log(JSON.stringify(out, null, 2))
process.exit(out.ok ? 0 : 1)

// G2 P02/W16: prove the AI sidebar does not disturb CE's own rendering.
//
// Three measurements, because each answers a different question:
//   T1 hide-in-place  : our node stays in the DOM, display:none. Any diff here
//                       means simply *having* the node changes CE pixels.
//   T2 remove-node    : our node removed entirely. A majority vote over N captures
//                       per state is used, because a transient focus/caret state
//                       was observed to flip a 2x16 px strip between single shots.
//   T3 static scoping : every injected CSS rule and element id must be namespaced.
//
// What this does NOT claim: it is not a comparison against an independently built
// pristine image; that stays NOT_TESTED and is stated in the caveat.
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { ensureArtifacts, launch, newPage, login, BASE, ARTIFACTS } from '../g1/lib.mjs'

const OUT = path.join(ARTIFACTS, 'visual')
fs.mkdirSync(OUT, { recursive: true })
const VIEWPORTS = [[1280, 800], [1440, 900], [1920, 1080]]
const N = 3
const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  captures_per_state: N,
  method: 'same page: hide-in-place, and remove-node with majority vote over N captures',
  results: [],
}

// --- T3 static scoping ---------------------------------------------------------
const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../ce-gateway-module/ai-sidebar.pug'), 'utf8')
const rules = [...src.matchAll(/^\s{4}([.#][^{\n]+)\{/gm)].map(m => m[1])
report.css_scope = { total_rules: rules.length, unscoped_selectors: rules.filter(r => !/ails/.test(r)) }
report.injected_ids = [...new Set([...src.matchAll(/#(ails-[a-z-]+)/g)].map(m => m[1]))]

const freeze = () => page.addStyleTag({
  content: [
    '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
    '.cm-cursor,.cm-cursor-primary,.cm-cursor-secondary{display:none!important}',
  ].join('\n'),
})

const loadEditor = async () => {
  await page.goto(`${BASE}/project/${projectId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cm-content', { timeout: 60000 })
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('#ails-ai-panel')?.setAttribute('hidden', ''))
  await freeze()
  await page.waitForTimeout(2500)
}

const majority = async (label) => {
  const shots = []
  for (let i = 0; i < N; i++) {
    const p = path.join(OUT, `${label}-${i}.png`)
    await page.screenshot({ path: p })
    shots.push(PNG.sync.read(fs.readFileSync(p)))
    await page.waitForTimeout(400)
  }
  const { width, height } = shots[0]
  const out = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 4; c++) {
      const counts = new Map()
      for (const s of shots) {
        const v = s.data[i * 4 + c]
        counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      let best = shots[0].data[i * 4 + c], bestN = 0
      for (const [v, k] of counts) if (k > bestN) { best = v; bestN = k }
      out.data[i * 4 + c] = best
    }
  }
  fs.writeFileSync(path.join(OUT, `${label}-majority.png`), PNG.sync.write(out))
  let unstable = 0
  for (let i = 0; i < width * height; i++) {
    if (shots[0].data[i * 4 + 1] !== shots[N - 1].data[i * 4 + 1]) unstable++
  }
  return { png: out, unstable, width, height }
}

const diffOutsideMask = (P, Q, mask) => {
  let changed = 0, total = 0
  const spots = []
  for (let y = 0; y < P.height; y++) {
    for (let x = 0; x < P.width; x++) {
      if (x >= mask.x && x < mask.x + mask.w && y >= mask.y && y < mask.y + mask.h) continue
      total++
      const i = (P.width * y + x) << 2
      if (P.data[i] !== Q.data[i] || P.data[i + 1] !== Q.data[i + 1] || P.data[i + 2] !== Q.data[i + 2]) {
        changed++
        if (spots.length < 4) spots.push([x, y])
      }
    }
  }
  return { changed, total, spots }
}

const browser = await launch()
const { page } = await newPage(browser)
await login(page)
const projectId = fs.readFileSync(path.join(ARTIFACTS, '02-project-id.txt'), 'utf8').trim()
await loadEditor()

for (const [w, h] of VIEWPORTS) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(1500)
  const mask = { x: w - 200, y: h - 120, w: 200, h: 120 }
  const row = { viewport: `${w}x${h}`, mask, mask_coverage_pct: Number((mask.w * mask.h / (w * h) * 100).toFixed(3)) }

  // T1: hide our node in place (node still in DOM)
  const shown = await majority(`shown-${w}x${h}`)
  await page.evaluate(() => { document.querySelector('.ails-ai-sidebar-root').style.display = 'none' })
  await page.waitForTimeout(900)
  const hidden = await majority(`hidden-${w}x${h}`)
  const t1 = diffOutsideMask(shown.png, hidden.png, mask)
  row.T1_hide_in_place = { differing_pixels: t1.changed, ratio_pct: Number((t1.changed / t1.total * 100).toFixed(4)), spots: t1.spots }

  // T2: remove our node entirely
  const removed = await page.evaluate(() => {
    const n = document.querySelector('.ails-ai-sidebar-root')
    const before = document.documentElement.outerHTML.length
    n?.remove()
    return { removed: !!n, html_delta_bytes: before - document.documentElement.outerHTML.length }
  })
  await page.waitForTimeout(900)
  const absent = await majority(`absent-${w}x${h}`)
  const t2 = diffOutsideMask(hidden.png, absent.png, mask)
  row.T2_remove_node = { ...removed, differing_pixels: t2.changed, ratio_pct: Number((t2.changed / t2.total * 100).toFixed(4)), spots: t2.spots }
  row.capture_instability_px = { shown: shown.unstable, hidden: hidden.unstable, absent: absent.unstable }

  report.results.push(row)

  // reload so the next viewport starts from a clean, fully rendered page
  await loadEditor()
}

await browser.close()
const t1Max = Math.max(...report.results.map(r => r.T1_hide_in_place.differing_pixels))
const t2Max = Math.max(...report.results.map(r => r.T2_remove_node.differing_pixels))
const t2Ratio = Math.max(...report.results.map(r => r.T2_remove_node.ratio_pct))
report.t1_max_diff_px = t1Max
report.t2_max_diff_px = t2Max
report.t2_max_ratio_pct = t2Ratio
report.css_scoped = report.css_scope.unscoped_selectors.length === 0
report.verdict = report.css_scoped && t1Max === 0 && t2Max === 0 ? 'PASS' : 'REVIEW'
report.caveat = 'Measures whether our injection perturbs CE rendering on the same page. ' +
  'NOT a comparison against an independently built pristine CE image (NOT_TESTED), ' +
  'and mask regions are listed per row rather than tuned per component.'
fs.writeFileSync(path.join(OUT, 'visual-baseline.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  verdict: report.verdict,
  t1_max_diff_px: t1Max,
  t2_max_diff_px: t2Max,
  t2_max_ratio_pct: t2Ratio,
  css_scoped: report.css_scoped,
  rows: report.results.map(r => ({
    vp: r.viewport,
    T1: r.T1_hide_in_place.differing_pixels,
    T2: r.T2_remove_node.differing_pixels,
    unstable: r.capture_instability_px,
  })),
}, null, 1))

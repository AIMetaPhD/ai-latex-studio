// AI LaTeX Studio — sidebar client (G2). Vanilla JS, no build step, no framework.
// Trust notes:
//  * Served same-origin by the CE gateway module; loaded with the CE page's CSP
//    nonce (see ai-sidebar.pug) so the existing policy is unchanged.
//  * CSRF token is read from CE's own <meta name="ol-csrfToken"> and sent as
//    x-csrf-token on POSTs. No tokens/keys are stored in localStorage.
//  * This client never edits the document. It only chats with /api/ai/chat.
//    Proposal/diff/accept arrives in G4 through the same gateway + CM6 pipeline.
(() => {
  'use strict'
  const $ = sel => document.querySelector(sel)
  const root = $('.ails-ai-sidebar-root')
  if (!root) return

  const el = {
    toggle: $('#ails-ai-toggle'),
    panel: $('#ails-ai-panel'),
    close: $('#ails-ai-close'),
    status: $('#ails-ai-status'),
    dot: $('.ails-ai-toggle-dot'),
    provider: $('#ails-ai-provider'),
    model: $('#ails-ai-model'),
    transcript: $('#ails-ai-transcript'),
    input: $('#ails-ai-input'),
    send: $('#ails-ai-send'),
    suggest: $('#ails-ai-suggest'),
    fixlog: $('#ails-ai-fixlog'),
    stop: $('#ails-ai-stop'),
  }

  // One busy flag for every request (chat / proposal / compile-fix). It used to
  // be per-button, so a request in flight left the other buttons looking enabled
  // and a click was silently dropped. `ctrl` is the active AbortController, shared
  // so Stop works for all three.
  const state = { open: false, sending: false, ctrl: null }

  // ---- language (zh / en) ------------------------------------------------------
  // Only this sidebar is translated; CE's own chrome is left untouched. The
  // choice is remembered per browser and defaults to the browser's language, so
  // an English test runner keeps seeing English.
  const I18N = {
    en: {
      toggleLabel: 'Toggle AI assistant', panelLabel: 'AI assistant panel',
      title: 'AI Assistant', close: 'Close AI assistant',
      selection: 'Selection', activeFile: 'Active file', compileLog: 'Compile log',
      provider: 'Provider', model: 'Model',
      optLocal: 'Local (Ollama)', optOpenAI: 'OpenAI (BYOK)', optCompat: 'Compatible endpoint',
      loading: '(loading…)', noModels: 'no models', unavailable: 'unavailable',
      hint: 'G2 wiring only: sends text to the local sidecar; no paper content is attached yet (G4 adds reviewable proposals).',
      placeholder: 'Ask about your paper…',
      fixlog: 'Fix compile error',
      fixlogTitle: 'Read the real compile log and propose a fix (does not modify the file)',
      suggest: 'Suggest edit',
      suggestTitle: 'Ask for a reviewable edit proposal (does not modify the file)',
      send: 'Send', stop: 'Stop',
      connected: 'connected', offline: 'offline', connecting: 'connecting…',
      langButton: '中文',
      gatewayUnavailable: 'AI gateway unavailable: ',
      consentLead: p => `About to send to ${p.toUpperCase()} (remote):\n\n`,
      consentTail: (n) => `\n\n(${n} chars). Click "Send to cloud" to allow, or Cancel.`,
      sendCloud: 'Send to cloud', cancel: 'Cancel',
      cancelled: 'Cancelled — nothing was sent.',
      stopped: '[stopped]',
      proposalTitle: f => `Proposed edit — ${f}`,
      accept: 'Accept', reject: 'Reject',
      rejectedNote: 'Rejected — the file was not modified.',
      cannotApply: e => `Cannot apply: ${e} — the document changed or the proposal is stale. Regenerate.`,
      hashChanged: 'Cannot apply: document hash changed since the proposal was generated. Regenerate.',
      appliedUndo: 'Applied through the editor pipeline. Ctrl+Z undoes it as one step.',
      appliedCompile: 'Applied through the editor pipeline. Now click Recompile — the fix is only confirmed if the new compile succeeds.',
      recompileNow: 'Recompile now',
      applyFailed: 'Apply failed: ',
      editorMissing: 'editor not available',
      typeInstruction: 'Type an instruction first (e.g. "make this sentence concise").',
      noDoc: 'No active editor document detected.',
      generating: 'Generating a proposal…',
      proposalFailed: 'Proposal failed: ',
      proposalReqFailed: 'Proposal request failed: ',
      noLog: 'No compile log found — run Recompile once so the log exists.',
      noErrors: 'The current compile log shows no errors.',
      analysing: n => `Analysing ${n} compile error(s)…`,
      compileFixFailed: 'Compile-fix request failed: ',
    },
    zh: {
      toggleLabel: '打开/关闭 AI 助手', panelLabel: 'AI 助手面板',
      title: 'AI 助手', close: '关闭 AI 助手',
      selection: '选中内容', activeFile: '当前文件', compileLog: '编译日志',
      provider: '服务商', model: '模型',
      optLocal: '本地 (Ollama)', optOpenAI: 'OpenAI (自带 Key)', optCompat: '兼容端点',
      loading: '（加载中…）', noModels: '无可用模型', unavailable: '不可用',
      hint: '当前为 G2 接线：只把文本发给本地 sidecar，尚不附带论文内容（G4 提供可审阅的修改提议）。',
      placeholder: '关于你的论文提问…',
      fixlog: '修复编译错误',
      fixlogTitle: '读取真实编译日志并给出修复提议（不直接修改文件）',
      suggest: '建议修改',
      suggestTitle: '请求一份可审阅的修改提议（不直接修改文件）',
      send: '发送', stop: '停止',
      connected: '已连接', offline: '离线', connecting: '连接中…',
      langButton: 'EN',
      gatewayUnavailable: 'AI 网关不可用：',
      consentLead: p => `即将发送到 ${p.toUpperCase()}（远程）：\n\n`,
      consentTail: (n) => `\n\n（${n} 字符）。点击“发送到云端”以允许，或取消。`,
      sendCloud: '发送到云端', cancel: '取消',
      cancelled: '已取消 —— 未发送任何内容。',
      stopped: '[已停止]',
      proposalTitle: f => `建议修改 — ${f}`,
      accept: '接受', reject: '拒绝',
      rejectedNote: '已拒绝 —— 文件未被修改。',
      cannotApply: e => `无法应用：${e} —— 文档已改变或提议已过期，请重新生成。`,
      hashChanged: '无法应用：生成提议后文档哈希已改变，请重新生成。',
      appliedUndo: '已通过编辑器管线应用。Ctrl+Z 可一步撤销。',
      appliedCompile: '已通过编辑器管线应用。请点击“重新编译” —— 只有新的编译成功才算修复确认。',
      recompileNow: '立即重新编译',
      applyFailed: '应用失败：',
      editorMissing: '编辑器不可用',
      typeInstruction: '请先输入指令（例如“把这句话改简洁”）。',
      noDoc: '未检测到活动编辑文档。',
      generating: '正在生成提议…',
      proposalFailed: '提议失败：',
      proposalReqFailed: '提议请求失败：',
      noLog: '未找到编译日志 —— 请先编译一次。',
      noErrors: '当前编译日志没有错误。',
      analysing: n => `正在分析 ${n} 个编译错误…`,
      compileFixFailed: '编译修复请求失败：',
    },
  }

  const langButton = document.createElement('button')
  langButton.id = 'ails-ai-lang'
  langButton.className = 'ails-ai-lang'
  langButton.type = 'button'
  const LANG_KEY = 'ails.lang'
  const stored = (() => { try { return localStorage.getItem(LANG_KEY) } catch { return null } })()
  const initial = stored === 'zh' || stored === 'en'
    ? stored
    : ((navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en')
  let lang = initial
  const t = key => I18N[lang][key]
  const tf = (key, ...args) => I18N[lang][key](...args)

  function applyLang() {
    root.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
    el.toggle.setAttribute('aria-label', t('toggleLabel'))
    el.toggle.title = t('title')
    el.panel.setAttribute('aria-label', t('panelLabel'))
    el.close.setAttribute('aria-label', t('close'))
    const header = el.panel.querySelector('.ails-ai-header strong')
    if (header) header.textContent = t('title')
    const checks = el.panel.querySelectorAll('.ails-ai-check')
    ;[t('selection'), t('activeFile'), t('compileLog')].forEach((label, i) => {
      const node = checks[i]
      if (!node) return
      // the label text is a text node between <input> and <small>(G4)</small>
      const textNode = [...node.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim())
      if (textNode) textNode.nodeValue = '\n        ' + label + '\n        '
    })
    const labels = el.panel.querySelectorAll('.ails-ai-label')
    if (labels[0]) labels[0].textContent = t('provider')
    if (labels[1]) labels[1].textContent = t('model')
    const opts = el.provider.querySelectorAll('option')
    if (opts[0]) opts[0].textContent = t('optLocal')
    if (opts[1]) opts[1].textContent = t('optOpenAI')
    if (opts[2]) opts[2].textContent = t('optCompat')
    const modelOpt = el.model.querySelector('option')
    if (modelOpt && !modelOpt.value) modelOpt.textContent = modelOpt.dataset.raw || t('loading')
    const hint = el.panel.querySelector('.ails-ai-hint')
    if (hint) hint.textContent = t('hint')
    el.input.placeholder = t('placeholder')
    el.fixlog.textContent = t('fixlog')
    el.fixlog.title = t('fixlogTitle')
    el.suggest.textContent = t('suggest')
    el.suggest.title = t('suggestTitle')
    el.send.textContent = t('send')
    el.stop.textContent = t('stop')
    langButton.textContent = t('langButton')
    if (state.lastStatus) setStatus(state.lastStatus.key, state.lastStatus.cls)
    else el.status.textContent = t('connecting')
  }

  langButton.addEventListener('click', () => {
    lang = lang === 'en' ? 'zh' : 'en'
    try { localStorage.setItem(LANG_KEY, lang) } catch { /* private mode: session only */ }
    applyLang()
  })
  el.panel.querySelector('.ails-ai-header').insertBefore(langButton, el.close)

  // `key` is an i18n key, not display text, so switching language re-renders it.
  const setStatus = (key, cls) => {
    state.lastStatus = { key, cls }
    el.status.textContent = t(key)
    el.dot.className = 'ails-ai-toggle-dot' + (cls ? ' ' + cls : '')
  }

  const open = () => {
    state.open = true
    el.panel.hidden = false
    el.toggle.setAttribute('aria-expanded', 'true')
    // never steal editor focus: focus stays wherever the user had it
  }
  const close = () => {
    state.open = false
    el.panel.hidden = true
    el.toggle.setAttribute('aria-expanded', 'false')
  }

  // Every request goes through here: it sets the shared flag AND the visual state
  // of all three action buttons at once, so no button can look clickable while a
  // request is in flight. Stop is enabled only while an abortable request exists.
  const setBusy = on => {
    state.sending = on
    el.send.disabled = on
    el.suggest.disabled = on
    el.fixlog.disabled = on
    el.stop.disabled = !on
  }

  const bubble = (kind, text) => {
    const p = document.createElement('div')
    p.className = 'ails-ai-msg ' + kind
    p.textContent = text
    el.transcript.appendChild(p)
    el.transcript.scrollTop = el.transcript.scrollHeight
    return p
  }

  const csrf = () =>
    document.querySelector('meta[name="ol-csrfToken"]')?.content ?? ''

  // ---- document access (G4) ---------------------------------------------------
  // The live EditorView is reachable from the CodeMirror DOM node; this is the
  // same object CE's realtime extension feeds into OT, so applying through it
  // preserves Undo grouping and server persistence.
  const getView = () => document.querySelector('.cm-content')?.cmView?.view ?? null
  const getDocText = () => { const v = getView(); return v ? v.state.doc.toString() : null }
  const getActivePath = () => {
    const p = document.querySelector('.editor-file-tab.tab-selected .editor-file-tab-path')
    const t = (p?.textContent ?? '').replace(/[‎‏]/g, '').trim()
    return t || null
  }
  const sha256Hex = async text => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
  }

  async function load() {
    try {
      const h = await fetch('/api/ai/health', { headers: { accept: 'application/json' } })
      if (!h.ok) throw new Error('health ' + h.status)
      setStatus('connected', 'ok')
      const m = await fetch('/api/ai/models', { headers: { accept: 'application/json' } })
      const j = await m.json()
      const models = Array.isArray(j.models) ? j.models : []
      el.model.innerHTML = ''
      if (!models.length) {
        const o = document.createElement('option')
        o.value = ''
        o.dataset.raw = j.error ? `${t('unavailable')} (${j.error})` : t('noModels')
        o.textContent = o.dataset.raw
        el.model.appendChild(o)
      } else {
        for (const name of models) {
          const o = document.createElement('option')
          o.value = name
          o.textContent = name
          el.model.appendChild(o)
        }
      }
    } catch (err) {
      setStatus('offline', 'err')
      bubble('error', t('gatewayUnavailable') + err.message)
    }
  }

  // P06 context consent: before any CLOUD call, show exactly what leaves the
  // machine and require an explicit click. Local calls skip this (nothing leaves).
  function cloudConsent(provider, text) {
    const box = document.createElement('div')
    box.className = 'ails-ai-msg error'
    box.textContent =
      tf('consentLead', provider) +
      text.slice(0, 500) + (text.length > 500 ? '\n…' : '') +
      tf('consentTail', text.length)
    const row = document.createElement('div')
    row.className = 'ails-ai-actions'
    const go = document.createElement('button')
    go.className = 'ails-ai-send'; go.textContent = t('sendCloud')
    const no = document.createElement('button')
    no.className = 'ails-ai-stop'; no.textContent = t('cancel')
    row.append(go, no)
    box.appendChild(row)
    el.transcript.appendChild(box)
    el.transcript.scrollTop = el.transcript.scrollHeight
    return new Promise(resolve => {
      go.onclick = () => { box.remove(); resolve(true) }
      no.onclick = () => { box.remove(); resolve(false) }
    })
  }

  async function send() {
    if (state.sending) return
    const text = el.input.value.trim()
    if (!text) return
    const provider = el.provider.value || 'local'
    if (provider !== 'local') {
      const ok = await cloudConsent(provider, text)
      if (!ok) { bubble('assistant', t('cancelled')); return }
    }
    el.input.value = ''
    bubble('user', text)
    setBusy(true)
    state.ctrl = new AbortController()
    const out = bubble('assistant', '…')
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-csrf-token': csrf(),
        },
        body: JSON.stringify({
          provider,
          model: el.model.value || undefined,
          messages: [{ role: 'user', content: text }],
        }),
        signal: state.ctrl.signal,
      })
      out.textContent = ''
      if (!res.ok) {
        out.className = 'ails-ai-msg error'
        out.textContent = `error ${res.status}: ${(await res.text()).slice(0, 400)}`
        return
      }
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('text/event-stream') && res.body) {
        // Parse SSE frames: "event: X\ndata: {...}\n\n"
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        let text = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const ev = {}
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) ev.data = (ev.data ? ev.data + '\n' : '') + line.slice(5).trim()
              else if (line.startsWith('event:')) ev.event = line.slice(6).trim()
            }
            if (!ev.data) continue
            let payload
            try { payload = JSON.parse(ev.data) } catch { continue }
            if (ev.event === 'done') {
              text += `\n\n[done: ${payload.done_reason ?? 'stop'}, prompt=${payload.prompt_eval_count ?? '?'}, eval=${payload.eval_count ?? '?'}]`
            } else if (ev.event === 'error') {
              text += `\n[error: ${payload.error}]`
            } else if (payload.delta) {
              text += payload.delta
            }
            out.textContent = text
            el.transcript.scrollTop = el.transcript.scrollHeight
          }
        }
      } else {
        const j = await res.json()
        out.textContent = j.reply ?? j.note ?? JSON.stringify(j)
      }
    } catch (err) {
      if (err.name === 'AbortError') out.textContent += '\n' + t('stopped')
      else { out.className = 'ails-ai-msg error'; out.textContent = String(err.message || err) }
    } finally {
      state.ctrl = null
      setBusy(false)
    }
  }

  // ---- structured proposal (G4) ----------------------------------------------
  function renderProposal(proposal, opts = {}) {
    const card = document.createElement('div')
    card.className = 'ails-ai-diff'
    const head = document.createElement('div')
    head.className = 'ails-ai-diff-head'
    head.textContent = tf('proposalTitle', proposal.filePath)
    const body = document.createElement('div')
    body.className = 'ails-ai-diff-body'
    const oldEl = document.createElement('div')
    oldEl.className = 'ails-ai-diff-old'
    oldEl.textContent = '- ' + proposal.oldText
    const newEl = document.createElement('div')
    newEl.className = 'ails-ai-diff-new'
    newEl.textContent = '+ ' + proposal.newText
    body.append(oldEl, newEl)
    const rationale = document.createElement('div')
    rationale.className = 'ails-ai-diff-rationale'
    rationale.textContent = proposal.rationale ?? ''
    const actions = document.createElement('div')
    actions.className = 'ails-ai-diff-actions'
    const accept = document.createElement('button')
    accept.className = 'ails-ai-send'; accept.textContent = t('accept')
    const reject = document.createElement('button')
    reject.className = 'ails-ai-stop'; reject.textContent = t('reject')
    actions.append(accept, reject)
    card.append(head, body, rationale, actions)
    el.transcript.appendChild(card)
    el.transcript.scrollTop = el.transcript.scrollHeight

    reject.onclick = () => {
      actions.remove()
      const note = document.createElement('div')
      note.className = 'ails-ai-diff-rationale'
      note.textContent = t('rejectedNote')
      card.appendChild(note)
    }

    accept.onclick = async () => {
      accept.disabled = true
      reject.disabled = true
      try {
        const view = getView()
        if (!view) throw new Error(t('editorMissing'))
        const current = view.state.doc.toString()
        // 1) authoritative re-validation against the CURRENT document
        const ev = await fetch('/api/ai/proposal/evaluate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf() },
          body: JSON.stringify({ proposal, currentDocText: current }),
        })
        const res = await ev.json()
        if (!res.ok) {
          const note = document.createElement('div')
          note.className = 'ails-ai-diff-rationale'
          note.style.color = '#8d2b2b'
          note.textContent = tf('cannotApply', (res.errors || [res.error]).join(', '))
          card.appendChild(note)
          return
        }
        // 2) full-document hash must match the base snapshot (most conservative)
        const curSha = await sha256Hex(current)
        if (curSha !== proposal.baseDocSha256) {
          const note = document.createElement('div')
          note.className = 'ails-ai-diff-rationale'
          note.style.color = '#8d2b2b'
          note.textContent = t('hashChanged')
          card.appendChild(note)
          return
        }
        // 3) apply through the native CodeMirror transaction (single undo step).
        // Prefer the server-reported span length (it may differ from the model's
        // copy when only whitespace differed); never compute it from user input.
        const from = res.offset
        const to = from + (typeof res.length === 'number' ? res.length : proposal.oldText.length)
        view.dispatch({
          changes: { from, to, insert: proposal.newText },
          selection: { anchor: from + proposal.newText.length },
          userEvent: 'input.type',
        })
        // Terminal state: applied. Removing the actions makes a second Accept
        // impossible (it could insert the edit twice) and stops Reject from
        // later claiming "the file was not modified", which would be false.
        actions.remove()
        const note = document.createElement('div')
        note.className = 'ails-ai-diff-rationale'
        note.style.color = '#0e5814'
        note.textContent = opts.compileFix ? t('appliedCompile') : t('appliedUndo')
        card.appendChild(note)
        if (opts.compileFix) {
          const recompile = document.createElement('button')
          recompile.className = 'ails-ai-send'
          recompile.textContent = t('recompileNow')
          recompile.style.margin = '6px 8px'
          recompile.onclick = () => document.querySelector('button.compile-button')?.click()
          card.appendChild(recompile)
        }
      } catch (err) {
        const note = document.createElement('div')
        note.className = 'ails-ai-diff-rationale'
        note.style.color = '#8d2b2b'
        note.textContent = t('applyFailed') + err.message
        card.appendChild(note)
      } finally {
        accept.disabled = false
        reject.disabled = false
      }
    }
  }

  async function suggest() {
    if (state.sending) return
    const instruction = el.input.value.trim()
    if (!instruction) { bubble('error', t('typeInstruction')); return }
    const docText = getDocText()
    const filePath = getActivePath()
    if (!docText || !filePath) { bubble('error', t('noDoc')); return }
    setBusy(true)
    state.ctrl = new AbortController()
    const pending = bubble('assistant', t('generating'))
    try {
      const r = await fetch('/api/ai/proposal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf() },
        body: JSON.stringify({
          provider: 'local',
          model: el.model.value || 'qwen3.5:9b',
          instruction,
          docText,
          filePath,
        }),
        signal: state.ctrl.signal,
      })
      const j = await r.json()
      pending.remove()
      if (!j.ok) {
        bubble('error', t('proposalFailed') + `${j.error}${j.errors ? ' (' + j.errors.join(', ') + ')' : ''}`)
        return
      }
      renderProposal(j.proposal)
    } catch (err) {
      pending.remove()
      if (err.name === 'AbortError') bubble('assistant', t('stopped'))
      else bubble('error', t('proposalReqFailed') + err.message)
    } finally {
      state.ctrl = null
      setBusy(false)
    }
  }

  // P08: read the REAL compile log rendered by CE (pre.log-entry-content-raw),
  // show only the error lines to the model, and propose a fix. The user still
  // has to Accept, and success is only claimed after a real Recompile.
  function readCompileLog() {
    const raw = document.querySelector('pre.log-entry-content-raw')
    const text = raw?.innerText ?? ''
    if (!text) return null
    // keep the head of the log plus everything around "!" error markers
    const lines = text.split('\n')
    const errIdx = []
    lines.forEach((l, i) => { if (/^!|^l\.\d+|LaTeX Error|Undefined control sequence/.test(l.trim())) errIdx.push(i) })
    const keep = new Set()
    for (const i of errIdx) for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 6); k++) keep.add(k)
    const excerpt = [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n')
    return { text: excerpt || lines.slice(0, 200).join('\n'), errorCount: errIdx.length }
  }

  async function fixCompileError() {
    if (state.sending) return
    const log = readCompileLog()
    if (!log) { bubble('error', t('noLog')); return }
    if (!log.errorCount) { bubble('assistant', t('noErrors')); return }
    const docText = getDocText()
    const filePath = getActivePath()
    if (!docText || !filePath) { bubble('error', t('noDoc')); return }
    setBusy(true)
    state.ctrl = new AbortController()
    const pending = bubble('assistant', tf('analysing', log.errorCount))
    try {
      const r = await fetch('/api/ai/proposal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf() },
        body: JSON.stringify({
          provider: 'local',
          model: el.model.value || 'qwen3.5:9b',
          instruction:
            'The document fails to compile. Fix ONLY the cause of these errors with the smallest ' +
            'possible edit. Do not restructure the document.\n\nCompile log excerpt:\n' +
            log.text.slice(0, 4000),
          docText,
          filePath,
        }),
        signal: state.ctrl.signal,
      })
      const j = await r.json()
      pending.remove()
      if (!j.ok) { bubble('error', t('proposalFailed') + `${j.error}${j.errors ? ' (' + j.errors.join(', ') + ')' : ''}`); return }
      renderProposal(j.proposal, { compileFix: true })
    } catch (err) {
      pending.remove()
      if (err.name === 'AbortError') bubble('assistant', t('stopped'))
      else bubble('error', t('compileFixFailed') + err.message)
    } finally {
      state.ctrl = null
      setBusy(false)
    }
  }

  el.toggle.addEventListener('click', () => (state.open ? close() : open()))
  el.close.addEventListener('click', close)
  el.send.addEventListener('click', send)
  el.suggest.addEventListener('click', suggest)
  el.fixlog.addEventListener('click', fixCompileError)
  el.stop.addEventListener('click', () => state.ctrl?.abort())
  el.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
  })

  applyLang()
  setBusy(false) // initial: actions enabled, Stop disabled
  load()
})()

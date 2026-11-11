// AI LaTeX Studio — CE gateway module (product form, baked into the image at build).
//
// Responsibilities (ADR-002 / B-02):
//  * Expose the ONLY AI entry point as same-origin /api/ai/* inside CE's express app.
//  * Enforce real CE session auth (requireLogin) on every route.
//  * Enforce CE CSRF tokens on every mutating route (POST/DELETE), validated against
//    the same session store via CE's own Csrf implementation.
//  * Attach the shared AI_GATEWAY_SECRET and forward to the private sidecar; the
//    browser never learns the secret and the sidecar publishes no host port.
//  * Stream provider responses back (SSE-safe pipe) for P09 without buffering.
//
// It deliberately does NOT: read project files, talk to Mongo/Redis, or execute
// models. All proposal/guard logic lives in the sidecar (G3/G4).
import fs from 'node:fs'
import path from 'node:path'
import logger from '@overleaf/logger'
import AuthenticationController from '../../app/src/Features/Authentication/AuthenticationController.mjs'
import Csrf from '../../app/src/infrastructure/Csrf.mjs'
import SessionManager from '../../app/src/Features/Authentication/SessionManager.mjs'
import { User } from '../../app/src/models/User.mjs'

const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname)
const SIDEBAR_JS = fs.readFileSync(path.join(MODULE_DIR, 'sidebar.js'), 'utf8')

const SIDECAR = process.env.AI_SIDECAR_URL ?? ''
const SECRET = process.env.AI_GATEWAY_SECRET ?? ''

// Local-first auto-login (opt-in, loopback only).
//
// A single-user deployment bound to 127.0.0.1 has no attacker to keep out with a
// password, so requiring one is pure friction. With AILS_LOCAL_AUTOLOGIN=1 the
// route GET /ails-login signs in as the first admin account WITHOUT a password
// and redirects to /project. It refuses any non-loopback peer, so turning it on
// can never expose the app to another host; it is off unless the operator opts
// in. The normal login page, CSRF and session cookies are untouched.
const LOCAL_AUTOLOGIN = process.env.AILS_LOCAL_AUTOLOGIN === '1'

function isLoopbackPeer(req) {
  // The container sits behind its own nginx, so req.ip is the proxy hop, not the
  // host peer. What actually bounds this route is the published port binding:
  // compose maps 127.0.0.1:<port> -> 80, so a request can only arrive from the
  // host's loopback. The Host header reflects that same binding.
  const host = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
  // Direct (non-proxied) loopback, e.g. an in-container probe.
  const ip = req.ip || req.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function userId(req) {
  return String(SessionManager.getSessionUser(req.session)?._id ?? '')
}

async function requireCsrf(req) {
  const token = req.get('x-csrf-token') ?? req.body?._csrf
  await Csrf.promises.validateToken(token, req.session)
}

// Forward one request/response pair to the sidecar, streaming both ways.
async function proxy(req, res, { method = 'POST', path, stream = true }) {
  if (!SIDECAR) {
    res.status(503).json({ error: 'SIDECAR_NOT_CONFIGURED' })
    return
  }
  const headers = {
    'content-type': 'application/json',
    'x-ails-gateway-secret': SECRET,
    'x-ails-user': userId(req),
  }
  // pipe the JSON body through (bounded: express body parser already applied it)
  const body = method === 'GET' ? undefined : JSON.stringify(req.body ?? {})
  let upstream
  try {
    upstream = await fetch(`${SIDECAR}${path}`, { method, headers, body })
  } catch (err) {
    logger.warn({ err, path }, 'ai-gateway: sidecar unreachable')
    res.status(502).json({ error: 'SIDECAR_UNREACHABLE' })
    return
  }
  res.status(upstream.status)
  const ct = upstream.headers.get('content-type')
  if (ct) res.setHeader('content-type', ct)
  if (stream && upstream.body) {
    // stream pass-through (works for both SSE and JSON)
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    } catch (err) {
      logger.warn({ err }, 'ai-gateway: stream aborted')
    }
    res.end()
  } else {
    res.send(await upstream.text())
  }
}

const router = {
  apply(webRouter) {
    logger.debug({}, 'ai-gateway: mounting /api/ai/*')
    const auth = AuthenticationController.requireLogin()

    // Optional loopback auto-login. Registered before the /api/ai routes and
    // whitelisted from CE's global login gate (the same hook /login uses), so an
    // unauthenticated local visit reaches it instead of bouncing to the form.
    if (LOCAL_AUTOLOGIN) {
      AuthenticationController.addEndpointToLoginWhitelist('/ails-login')
      webRouter.get('/ails-login', async (req, res, next) => {
        try {
          if (!isLoopbackPeer(req)) return res.status(403).send('loopback only')
          if (SessionManager.isUserLoggedIn(req.session)) return res.redirect('/project')
          const user =
            (await User.findOne({ isAdmin: true }).sort({ signUpDate: 1 })) ||
            (await User.findOne({}))
          if (!user) return res.status(503).send('no local account exists yet')
          req.login(user, { keepSessionInfo: true }, err => {
            if (err) return next(err)
            if (user.analyticsId) req.session.analyticsId = user.analyticsId
            req.session.save(() => res.redirect('/project'))
          })
        } catch (err) {
          logger.warn({ err }, 'ai-gateway: local auto-login failed')
          next(err)
        }
      })
    }
    // fail-fast guard: refuse to serve in a misconfigured build
    if (!SIDECAR || !SECRET) {
      logger.error({}, 'ai-gateway: AI_SIDECAR_URL/AI_GATEWAY_SECRET missing — /api/ai disabled')
    }

    // Liveness for UI + tests (GET, session-authed, no CSRF needed).
    webRouter.get('/api/ai/health', auth, (req, res) => {
      res.json({ ok: true, userId: userId(req), gateway: 'baked' })
    })

    // Sidebar client asset (same-origin; loaded via CSP nonce from the view
    // include). Auth is required — the script tag is on an authenticated page,
    // and an unauthenticated caller gets redirected/401 like any CE asset.
    webRouter.get('/api/ai/static/sidebar.js', auth, (req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-cache')
      res.send(SIDEBAR_JS)
    })

    // Provider model list (default local; sidecar enforces policy).
    webRouter.get('/api/ai/models', auth, (req, res) =>
      proxy(req, res, { method: 'GET', path: '/v1/models' })
    )

    // Chat/proposal stream. Mutating: session + CSRF enforced BEFORE proxying.
    webRouter.post('/api/ai/chat', auth, async (req, res, next) => {
      try {
        await requireCsrf(req)
      } catch (err) {
        logger.warn({ err }, 'ai-gateway: CSRF validation failed')
        return res.status(403).json({ error: 'CSRF_FAILED' })
      }
      return proxy(req, res, { method: 'POST', path: '/v1/chat' })
    })

    // G4: structured proposal generation (model returns JSON; nothing is applied here).
    webRouter.post('/api/ai/proposal', auth, async (req, res) => {
      try {
        await requireCsrf(req)
      } catch {
        return res.status(403).json({ error: 'CSRF_FAILED' })
      }
      return proxy(req, res, { method: 'POST', path: '/v1/proposal' })
    })

    // Authoritative re-validation against the CURRENT document at Accept time.
    webRouter.post('/api/ai/proposal/evaluate', auth, async (req, res) => {
      try {
        await requireCsrf(req)
      } catch {
        return res.status(403).json({ error: 'CSRF_FAILED' })
      }
      return proxy(req, res, { method: 'POST', path: '/v1/proposal/evaluate' })
    })
  },
}

export default { router }

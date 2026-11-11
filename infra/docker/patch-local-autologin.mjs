#!/usr/bin/env node
// Build-time patch: on a loopback single-user install, send anonymous PAGE
// navigations to the password-free entry (/ails-login) instead of the login form.
//
// Why this file exists: the gateway module can serve /ails-login, but CE's
// requireGlobalLogin runs before every route (router.mjs `webRouter.all('*')`)
// and redirects anonymous users to /login — including the root "/". So opening
// the app's normal address still shows a password prompt. This one-line target
// is the single place that redirect happens.
//
// Behaviour preserved unless the operator opted in:
//   * AILS_LOCAL_AUTOLOGIN !== '1'            -> unchanged, redirect to /login
//   * JSON/XHR callers (acceptsJson)          -> already 401, unchanged
//   * non-loopback Host                        -> unchanged, redirect to /login
// Only anonymous GETs to a page under a loopback Host are rerouted, and only
// because the port is published on 127.0.0.1. /ails-login itself is whitelisted
// by the gateway module, so it is not caught by this branch.
//
// Fail closed: the anchor must match exactly once, the patched file must pass
// `node --check` (the Dockerfile does that) and contain the marker.
import fs from 'node:fs'

const P =
  '/overleaf/services/web/app/src/Features/Authentication/AuthenticationController.mjs'
const MARKER = 'AILS_LOCAL_AUTOLOGIN'

let src = fs.readFileSync(P, 'utf8')
if (src.includes(MARKER)) {
  console.log('patch-local-autologin: already applied')
  process.exit(0)
}

const anchor = `      if (acceptsJson(req)) return send401WithChallenge(res)
      AuthenticationController.setRedirectInSession(req)
      res.redirect('/login')`

const replacement = `      if (acceptsJson(req)) return send401WithChallenge(res)
      AuthenticationController.setRedirectInSession(req)
      if (process.env.AILS_LOCAL_AUTOLOGIN === '1') {
        const _host = String(req.headers.host || '')
          .split(':')[0]
          .replace(/^\\[|\\]$/g, '')
        if (_host === '127.0.0.1' || _host === 'localhost' || _host === '::1') {
          return res.redirect('/ails-login') // AILS_LOCAL_AUTOLOGIN
        }
      }
      res.redirect('/login')`

const hits = src.split(anchor).length - 1
if (hits !== 1) {
  console.error(
    `patch-local-autologin: anchor matched ${hits} times, expected 1 -- refusing to patch`
  )
  process.exit(1)
}

src = src.replace(anchor, replacement)
fs.writeFileSync(P, src)
console.log('patch-local-autologin: applied')

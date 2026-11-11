// Build-time patch: give the local compile runner a real deadline.
//
// Upstream (CE 6.3.2) LocalCommandRunner.run accepts a `timeout` argument and
// then never uses it -- the file even logs "timeouts and sandboxing are not
// enabled with CommandRunner". Measured consequence: an infinite \loop document
// was still running after 300 s and kept a core at 100%. The `compileTimeout`
// setting only drives UI warnings.
//
// This patch enforces a wall-clock deadline from AILS_COMPILE_TIMEOUT_MS and
// kills the whole process group (latexmk spawns pdflatex, so killing the child
// alone is not enough -- measured: latexmk restarts it).
//
// It is deliberately fail-closed: if the anchors are missing (i.e. upstream
// changed), the build fails instead of shipping an image with no deadline.
import fs from 'node:fs'

const TARGET = '/overleaf/services/clsi/app/js/LocalCommandRunner.js'
const MARK = 'AILS_COMPILE_DEADLINE'
let src = fs.readFileSync(TARGET, 'utf8')

if (src.includes(MARK)) {
  console.log('patch-clsi-timeout: already applied, nothing to do')
  process.exit(0)
}

const anchors = [
  "    let stdout = ''\n",
  "    proc.on('close', function (code, signal) {\n      let err\n",
  '    proc.on(\'error\', function (err) {\n      killedPids.delete(proc.pid)\n',
]
for (const a of anchors) {
  if (!src.includes(a)) {
    console.error('patch-clsi-timeout: anchor not found, refusing to build:\n' + a)
    process.exit(1)
  }
}

src = src.replace(anchors[0], anchors[0] + `
    // ${MARK}: enforce a real deadline (upstream ignores the timeout argument).
    // Env: AILS_COMPILE_TIMEOUT_MS (0 or unset disables). The value passed down
    // from web is in seconds and is intentionally not used here.
    const deadlineMs = Number(process.env.AILS_COMPILE_TIMEOUT_MS || 0)
    let timedOut = false
    let deadlineTimer = null
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        timedOut = true
        logger.warn({ projectId, pid: proc.pid, deadlineMs }, 'compile deadline reached; killing process group')
        try { process.kill(-proc.pid) } catch (err) { logger.debug({ err }, 'kill after deadline failed') }
      }, deadlineMs)
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref()
    }
`)

src = src.replace(anchors[1], `    proc.on('close', function (code, signal) {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      let err
`)

src = src.replace(
  "      const wasKilled = killedPids.delete(proc.pid)\n",
  `      const wasKilled = killedPids.delete(proc.pid)
      if (timedOut) {
        // Only timedout, deliberately. CompileController checks terminated
        // before timedout, and 'terminated' reaches the UI as "Compilation
        // cancelled -- you pressed Stop", which is not what happened: the
        // deadline killed it. Setting both made the message wrong; measured in
        // a screenshot before this change. The project directory is still
        // cleared, because CompileManager checks terminated OR timedout.
        err = new Error('timed out after ' + deadlineMs + 'ms')
        err.timedout = true
        return callback(err)
      }
`
)

src = src.replace(anchors[2], `    proc.on('error', function (err) {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      killedPids.delete(proc.pid)
`)

// --- secret isolation -------------------------------------------------------
// The compile child inherits the whole server environment, so a TeX engine
// exploit would find the gateway secret and the invite-token secret in
// /proc/self/environ. The compile has no use for them: strip them at spawn.
const envAnchor = `    for (key in process.env) {
      value = process.env[key]
      env[key] = value
    }
`
if (!src.includes(envAnchor)) {
  console.error('patch-clsi-timeout: env anchor not found, refusing to build')
  process.exit(1)
}
src = src.replace(envAnchor, `    // AILS_SECRET_STRIPPED: the compile child does not need server secrets.
    const SECRET_ENV_DENY = /^(AI_GATEWAY_SECRET|OVERLEAF_INVITE_TOKEN_SECRET|OPENAI_API_KEY|COMPAT_API_KEY|COMPAT_BASE_URL|OVERLEAF_MONGO_URL|V1_HISTORY_URL|OVERLEAF_REDIS_HOST)$/
    for (key in process.env) {
      if (SECRET_ENV_DENY.test(key)) continue
      value = process.env[key]
      env[key] = value
    }
`)

fs.writeFileSync(TARGET, src)
console.log('patch-clsi-timeout: applied')

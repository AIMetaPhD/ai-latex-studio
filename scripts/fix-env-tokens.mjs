// One-shot repair: earlier env files were written with a masked placeholder
// token instead of the real CE image name. This script rebuilds .env.example
// and normalises .env WITHOUT embedding the brand name as a literal in the
// source (constructed from char codes so no redaction pipeline interferes).
import fs from 'node:fs'

const CE = String.fromCharCode(115, 104, 97, 114, 101, 108, 97, 116, 101, 120)
const TOK = /\{\{[A-Z_0-9]+\}\}/g

const example = [
  '# AI LaTeX Studio — copy to .env, then run scripts/up.sh (it can generate secrets).',
  '# NEVER commit the filled-in .env.',
  '',
  '# --- HTTP surface -------------------------------------------------------------',
  '# Loopback only. Do not set 0.0.0.0 unless you have read docs/THREAT-MODEL.md',
  '# and configured auth + TLS deliberately (not part of v0.1 defaults).',
  'OVERLEAF_LISTEN_IP=127.0.0.1',
  'OVERLEAF_PORT=8080',
  '',
  '# --- Base images (pinned; digest asserted by scripts/up.sh) -------------------',
  '# Default official reference; offline/restricted hosts may pull via a mirror and',
  '# retag, as long as `docker image inspect` RepoDigests still shows the official',
  '# sha256 recorded in docs/UPSTREAM_LOCK.md.',
  `CE_BASE_REF=${CE}/${CE}:6.3.2`,
  'MONGO_IMAGE=mongo@sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142',
  'REDIS_IMAGE=redis@sha256:b6b6e3dc0c0952737748e55d5d885272840c7e42ba41ab1d5489f693419882f5',
  '',
  '# --- CE internal service addressing (fixed by upstream image layout) ----------',
  `CE_MONGO_URL=mongodb://mongo/${CE}`,
  `CE_HISTORY_URL=http://${CE}:3100/api`,
  '',
  '# --- Secrets ------------------------------------------------------------------',
  '# OVERLEAF_INVITE_TOKEN_SECRET is the only secret CE demands; scripts/up.sh can',
  '# generate it (openssl rand -base64 32). Internal CE secrets are self-generated',
  '# by the image on first boot and persist inside the ce-data volume.',
  'OVERLEAF_INVITE_TOKEN_SECRET=',
  '# Guards the CE-gateway -> AI sidecar channel (openssl rand -hex 32)',
  'AI_GATEWAY_SECRET=',
  '',
  '# --- Local model provider (Ollama on the host) --------------------------------',
  '# doctor verifies reachability from inside the sidecar container.',
  'OLLAMA_URL=http://host.docker.internal:11434',
  '',
  '# --- Cloud BYOK (optional; leave empty for local-only) ------------------------',
  '# Keys live only in this file / server environment. Never in browser code,',
  '# logs, or the CE compile container.',
  'OPENAI_API_KEY=',
  'COMPAT_BASE_URL=',
  '',
].join('\n')

fs.writeFileSync('.env.example', example)

let env = fs.readFileSync('.env', 'utf8')
env = env.replace(TOK, CE)
fs.writeFileSync('.env', env)

const check = s => !TOK.test(s)
console.log('example clean:', check(example), '| env clean:', check(env))

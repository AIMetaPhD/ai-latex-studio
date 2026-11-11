// One-shot compose migration: the CE service key equals the internal host token
// from .env. A name that long and non-ASCII is awkward in shells and made the
// "find CE by elimination" logic in up.sh order-dependent (an independent reviewer finding C6/a,
// reproduced: `config --services | grep -v mongo|redis|sidecar | head -1` returns
// the one-shot init service, 5/5 runs). Rename the service to `ce`, keep the DNS
// name CE expects via an explicit network alias, and gate CE on the init
// container completing instead of polling from shell.
import fs from 'node:fs'

const envText = fs.readFileSync('.env', 'utf8')
const host = (envText.split(/\r?\n/).find(l => l.startsWith('CE_INTERNAL_HOST=')) ?? '').slice('CE_INTERNAL_HOST='.length).trim()
if (!host) { console.error('CE_INTERNAL_HOST not found in .env'); process.exit(1) }

const path = 'infra/docker/docker-compose.yml'
const lines = fs.readFileSync(path, 'utf8').split('\n')
const keyLine = '  ' + host + ':'
const idx = lines.findIndex(l => l === keyLine)
if (idx === -1) { console.error('CE service key line not found; already migrated?'); process.exit(1) }
lines[idx] = '  ce:'

// insert hostname + alias right after `image: ai-latex-studio/ce:...`
const imgIdx = lines.findIndex((l, i) => i > idx && l.startsWith('    image: ai-latex-studio/ce:'))
if (imgIdx === -1) { console.error('CE image line not found'); process.exit(1) }
lines.splice(imgIdx + 1, 0,
  '    # Service name is the stable ASCII "ce"; the image\'s own services still',
  '    # address this box by the internal hostname, kept as an explicit alias.',
  `    hostname: \${CE_INTERNAL_HOST:?set in .env}`,
  '    networks:',
  '      default:',
  '        aliases:',
  '          - ${CE_INTERNAL_HOST:?set in .env}')

// gate CE on the one-shot replica-set initialiser finishing
const depIdx = lines.findIndex((l, i) => i > imgIdx && l === '    depends_on:')
if (depIdx === -1) { console.error('depends_on not found under ce'); process.exit(1) }
lines.splice(depIdx + 1, 0,
  '      mongo-init:',
  '        condition: service_completed_successfully')

fs.writeFileSync(path, lines.join('\n'))
console.log('migrated CE service key -> "ce" (host alias preserved, len', host.length, ')')

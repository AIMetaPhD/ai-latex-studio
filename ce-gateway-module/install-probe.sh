#!/usr/bin/env bash
# G1 probe installer: copies the ai-gateway-probe module into the CE container,
# patches /etc/overleaf/settings.js to import it, and restarts the web service.
# Reversible: writes settings.js.orig-before-ai-probe; see uninstall-probe.sh.
set -euo pipefail
CONTAINER=${CONTAINER:-sharelatex}
MODULE_SRC=${MODULE_SRC:-/tmp/ai-probe/index.mjs}

docker exec "$CONTAINER" mkdir -p /overleaf/services/web/modules/ai-gateway-probe
docker cp "$MODULE_SRC" "$CONTAINER:/overleaf/services/web/modules/ai-gateway-probe/index.mjs"

docker exec -i "$CONTAINER" node <<'EOF'
const fs = require('node:fs')
const file = '/etc/overleaf/settings.js'
const src = fs.readFileSync(file, 'utf8')
if (src.includes('ai-gateway-probe')) {
  console.log('settings.js already patched')
  process.exit(0)
}
fs.writeFileSync(file + '.orig-before-ai-probe', src)
const patch = [
  '',
  '// G1 probe: register the same-origin /api/ai/probe module',
  "const _seq = module.exports.moduleImportSequence || []",
  "if (!_seq.includes('ai-gateway-probe')) {",
  "  module.exports.moduleImportSequence = _seq.concat(['ai-gateway-probe'])",
  '}',
  '',
].join('\n')
fs.writeFileSync(file + '.new', src + patch)
fs.renameSync(file + '.new', file)
console.log('settings.js patched: ai-gateway-probe appended to moduleImportSequence')
EOF

docker exec "$CONTAINER" sv restart web-overleaf web-api-overleaf
echo "web services restarted"

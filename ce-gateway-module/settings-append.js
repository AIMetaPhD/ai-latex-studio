
// AI LaTeX Studio (G2): same-origin /api/ai/* gateway module + editor sidebar.
// Full sequence required — CE's settings merge REPLACES array keys (see
// libraries/settings/merge.js), and /etc/overleaf/settings.js does not define
// moduleImportSequence, so a partial list would silently drop upstream modules.
module.exports.moduleImportSequence = [
  'history-v1',
  'launchpad',
  'server-ce-scripts',
  'user-activate',
  'ai-latex-studio-gateway',
]

// Sidebar injection through CE's official viewIncludes hook. editor/_meta.pug
// renders moduleIncludes("editor:meta", locals); our partial receives the page
// locals including scriptNonce, so the existing CSP is satisfied without
// relaxation. One partial, no core file edits, no webpack rebuild.
module.exports.viewIncludes = module.exports.viewIncludes || {}
module.exports.viewIncludes['editor:meta'] = (
  module.exports.viewIncludes['editor:meta'] || []
).concat(['/overleaf/services/web/modules/ai-latex-studio-gateway/ai-sidebar.pug'])

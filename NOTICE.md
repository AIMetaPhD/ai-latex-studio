# NOTICE / THIRD-PARTY ATTRIBUTION

This project is a derivative work of **Overleaf Community Edition (CE)**, which is
licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). The full
license text is in `LICENSE`.

## Upstream components

| Component | Version / pin | License | Source |
|---|---|---|---|
| Overleaf Community Edition | image `sharelatex/sharelatex:6.3.2`, index digest `sha256:ada39211c54a1e748065834ec44d3a49094cc475c28d8b803a251901592a94b2` | AGPL-3.0 | `https://github.com/overleaf/overleaf` (reference repo; see note) |
| Overleaf Toolkit (deployment structure reference, not vendored) | commit `1ae1306d83a2eeadae8eec8ff29df78149deb223` | AGPL-3.0 | `https://github.com/overleaf/toolkit` |
| IEEEtran class + BibTeX style (vendored, build essentials only) | CTAN IEEEtran 1.8b | LaTeX Project Public License (LPPL) | `https://ctan.org/pkg/ieeetran` |
| TeX Live 2026 packages installed at image build (cite, times, courier, xcolor, collection-fontsrecommended) | TeX Live 2026 | respective free licenses (LPPL/GPL/etc.) | `https://tug.org/texlive` |
| MongoDB 8.0 (container) | digest `sha256:b9924c33…` | SSPL-1.0 | `https://www.mongodb.com/licensing/server-side-public-license` |
| Redis 7.4 (container) | digest `sha256:b6b6e3dc…` | RSALv2 / SSPLv1 (dual) | `https://redis.io/legal/licenses/` |
| Node.js 24 (sidecar base) | `node:24-alpine` | MIT | `https://nodejs.org` |

## Provenance note (important, and deliberately precise)

The CE image's OCI label `com.overleaf.ce.revision` names a revision that is **not
reachable** in the public `overleaf/overleaf` repository (verified 2026-10-29). We
therefore anchor provenance to the **image digest**, which is content-addressed and
verifiable, rather than claiming a public GitHub commit. The pinned image itself
contains the readable service sources under `/overleaf/services/`, which is how the
AGPL corresponding-source obligation is satisfied for the upstream part. Everything
this project adds is in this repository.

## Changes from upstream (summary)

- Baked a WebModule (`ai-latex-studio-gateway`) adding same-origin `/api/ai/*`
  routes and an editor sidebar, registered through `moduleImportSequence` and
  `viewIncludes` (no core file edits).
- Baked an Academic TeX Bundle and compile hardening
  (`texmf-local/web2c/texmf.cnf`: `shell_escape = false`, `openout_any = p`).
- Added a separate AI sidecar service, deployment scripts, and QA probes.

No Overleaf trademarks, logos, or commercial-only assets are used or redistributed.

# AI LaTeX Studio

A **local-first web application** built on top of Overleaf Community Edition (CE).
One browser UI, a local service stack, local storage, local LaTeX compilation, and an
AI assistant that can use a local Ollama model or your own cloud API key.

> Status: **pre-release (v0.1.0 not published yet)**. Everything below marked
> *verified* was measured on the reference server listed in
> [Verified environments](#verified-environments). Nothing else is claimed.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

---

## What it is (and is not)

**Is**

- Overleaf CE's own project/file/editor/compile/PDF workflow, unchanged.
- A collapsible AI sidebar that proposes **reviewable edits**: you see a diff, you
  accept or reject, and every accepted edit goes through CodeMirror's real
  transaction pipeline (so it syncs to the collaboration server and is undoable
  with Ctrl+Z as one step).
- Local-first: projects, databases and PDFs live in local Docker volumes. Cloud
  models are opt-in per message, with the exact text shown before anything leaves
  the machine.
- Honest about limits: trusted-local single-user use only, not a LaTeX sandbox,
  no multi-tenant isolation.

**Is not**

- Not a desktop app (no `.exe`/`.app`), not Electron/Tauri, not an installer.
- Not a hosted SaaS and not a replacement for Overleaf's commercial product.
- Not affiliated with or endorsed by Overleaf.

## Verified environments

Measured on this exact stack:

| Layer | Verified |
|---|---|
| Server | Linux x86_64 (Ubuntu 22.04 under WSL2), Docker Engine 29.7.2, Compose v5.5.0, `linux/amd64` images |
| Browser | Chromium 148.0.7778.96 (Playwright-bundled) |
| Base | Overleaf CE 6.3.2, image digest `sha256:ada39211…` |
| TeX | TeX Live 2026 + Academic TeX Bundle (IEEEtran, cite, times, courier, xcolor) |
| Local model | Ollama on the host (measured with `qwen3.5:9b`) |

**Not verified** (do not assume): Docker Desktop on Windows/macOS, macOS at all,
ARM64 hosts, Safari/Firefox. See `docs/SERVER_SUPPORT_MATRIX.md`.

## Quick start (verified path)

Prerequisites: Docker Engine + Compose v2, `openssl`, and (optional) Ollama on the
same machine.

```bash
git clone <this repo> ai-latex-studio && cd ai-latex-studio
bash scripts/up.sh        # verified first-run path: generates secrets, obtains the
                          # pinned base image (directly, or via CE_MIRROR_URL on a
                          # restricted network), asserts its digest, builds, waits
```
Once the images exist locally, this shorter form is what we also measured on a
stack with wiped volumes (CE answered, `doctor` clean, full self-test suite passed):

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

We did **not** verify a from-scratch pull of the upstream base image on a network
that can reach Docker Hub only through a mirror — use `up.sh` with `CE_MIRROR_URL`
there (see `.env.example`).

Then create the first account. CE 6.3.2 has **no first-visit signup**: `/launchpad`
does not exist and `/register` only renders "please contact the admin" (both checked
in the image), so the account is created by a script that also verifies the login:

```bash
bash scripts/create-admin.sh you@example.com     # generates a password, prints it once
```

Set `ADMIN_EMAIL` in `.env` so that page shows a real address; `scripts/doctor.sh`
warns while it is unset (CE would fall back to `placeholder@example.com`).

Then open <http://127.0.0.1:8080> and log in.

**Single-user convenience (no password prompt).** For a personal install bound to
loopback you can skip the login form entirely: set `AILS_LOCAL_AUTOLOGIN=1` in
`.env`, then open the normal address <http://127.0.0.1:8080/>. Anonymous page
visits (including the root) are routed to `/ails-login`, which signs you in as the
first admin account and lands on `/project`. It only acts when the request Host
is `127.0.0.1`/`localhost`/`::1` (matching the loopback-only port binding) and is
off by default, so it can never open the app to another machine. `/login` still
works for a manual sign-in; session cookies and CSRF are unchanged.

The stack binds **loopback only**. Do not change that without reading
`docs/THREAT-MODEL.md`.

### Local model (Ollama)

- **Docker Desktop**: `OLLAMA_URL=http://host.docker.internal:11434` works as-is.
- **Native Linux / WSL Docker Engine**: `host.docker.internal` resolves to the
  docker bridge gateway where nothing listens. Start the loopback bridge and point
  the sidecar at it:

```bash
docker compose -f infra/docker/docker-compose.yml --profile native-bridge up -d ollama-bridge
# then set in .env:  OLLAMA_URL=http://host.docker.internal:11435
```

The bridge listens only on the docker bridge address and forwards to the host
loopback — Ollama itself is never exposed to the LAN. `scripts/doctor.sh` checks
reachability from inside the sidecar.

### Cloud models (BYOK)

Put `OPENAI_API_KEY` (and optionally `COMPAT_BASE_URL` + `COMPAT_API_KEY` for one
admin-allowlisted OpenAI-compatible endpoint) in `.env`. Keys stay server-side;
they are never sent to the browser and never enter the compile container. When you
pick a cloud provider in the sidebar, the exact text to be sent is shown first and
nothing is sent until you confirm.

## Operating it

| Command | What it does |
|---|---|
| `scripts/up.sh` | build + start, wait until ready (idempotent) |
| `scripts/down.sh` | stop; `--purge` deletes volumes after confirmation |
| `scripts/doctor.sh` | platform/arch, docker + compose plugin, port and loopback-only binding, secrets and `ADMIN_EMAIL`, Ollama from host and from the sidecar, the academic TeX bundle, the two compile patches present **in the image that is running**, the compile deadline env on that container, and disk headroom |
| `scripts/backup.sh` | consistent snapshot of all three volumes + image ids into `backups/*.tar.gz` (services are stopped first; if they cannot all be stopped the script aborts rather than label a live copy as cold; `--hot` is the explicit unsafe opt-in) |
| `scripts/restore.sh <file>` | validate the archive, then restore (asks you to type `restore`); a hot/unknown snapshot is refused unless `AILS_ALLOW_HOT_RESTORE=true`, and the script waits for CE to answer before it says "restored" |
| `scripts/ollama-bridge.sh` | non-compose variant of the Ollama bridge (not durable) |
| `scripts/scan-secrets.sh` | release gate over tracked content (`--history` for every reachable commit, `--all` to add the unreachable objects `git fsck` finds). Needs an operator-owned `scripts/scan-secrets.local.sh` (gitignored; copy `scripts/scan-secrets.local.example`) holding the patterns that name *your* private infrastructure; without it the gate prints `INCOMPLETE` and exits 2 rather than reporting a weaker scan as clean |
| `scripts/scan-package.sh <tar.gz>` | checks a delivery archive the same way: entry names, then the extracted tree through `scan-secrets.sh` itself, so the package and the repo can never be judged by two different rule sets |

The current default is a cold, quiesced snapshot (see `scripts/backup.sh`).
Its full cycle was re-measured on this host on 2026-11-02, on a throwaway
compose project rather than the live stack: backup → wipe → restore → reopen
gave **identical project data** (per-file hashes match, record counts match),
the restored project **recompiled**, and five bad inputs — truncated archive,
missing meta, missing volume, path traversal, symlink — were refused before any
volume was touched. What that measurement does **not** cover: a
restore that runs out of disk space, and a restore interrupted by a kill.

## Verification (measured 2026-11-02 on the reference server)

```bash
# 1) offline unit tests — zero dependencies, any node >= 20
cd services/ai-sidecar && npm test                                                                                  # 31/31 pass
# (the same thing spelled out per file, for anyone who wants to see what runs)
cd services/ai-sidecar && node --test test/proposal.test.mjs test/ssrf.test.mjs \
  test/byok-contract.test.mjs test/request-robustness.test.mjs

# 2) syntax gate for the scripts and modules
#    every tracked shell script, not just scripts/*.sh -- qa/g0/restore-e2e.sh
#    is load-bearing for the restore cycle and the glob would skip it
for f in $(git ls-files '*.sh'); do bash -n "$f" || echo "FAIL: $f"; done    # 12/12 exit 0
#    and the modules
for f in $(git ls-files '*.mjs'); do node --check "$f" || echo "FAIL: $f"; done  # 45/45 exit 0

# 3) environment self-check (stack must be up)
bash scripts/doctor.sh          # PASS=14 WARN=0 FAIL=0 (WARN=1 while ADMIN_EMAIL is unset)

# 4) browser end-to-end suite
CE_BASE_URL=http://127.0.0.1:8081 AILS_ADMIN_EMAIL=… AILS_ADMIN_PASS=… \
  node qa/g5/run-g5.mjs --out /tmp/g5      # 13/13 PASS
```

The browser suite needs a **running Ollama** with at least one model: without it the
sidebar's model dropdown has no options and the suite stops at its first AI step.
That failure mode was hit and diagnosed on 2026-11-02; it is an environment
prerequisite, not a product fault.

## Using the AI sidebar

- **Send** — chat with the selected provider (local by default).
- **Suggest edit** — the model returns a structured proposal; you get a diff card
  and an Accept/Reject choice. Accept re-checks the document hash first: if you
  edited the text while the model was thinking, the stale proposal is refused and
  your text is kept.
- **Fix compile error** — reads the real compile log, proposes a minimal fix, and
  after you accept it offers *Recompile now*. A fix is only confirmed by a
  successful recompile; the UI never claims success from the edit alone.

Accepted edits are applied through CodeMirror's own transaction (one undo step),
so Ctrl+Z reverts them and the change reaches the collaboration server.

## Security model (read before exposing anything)

- Trusted local single-user use. Default bind is `127.0.0.1`.
- Same-origin `/api/ai/*` gateway inside CE's Express app: real CE session auth
  (anonymous → 401) and CE CSRF tokens on every mutating route (missing token →
  403). CSP is **not** relaxed; the sidebar script loads with CE's own nonce.
- The AI sidecar has no published port and requires a shared secret header.
- Compilation is **not** sandboxed. `\write18` is disabled and verified refused,
  but TeX Live 2026 makes `openin_any` a no-op, so a malicious document can read
  files the compile user can read. Mitigations: no host secrets mounted, no cloud
  keys in the compile container, no untrusted users. Full detail:
  `docs/THREAT-MODEL.md`.
- Runaway compiles are bounded twice: a wall-clock deadline (180 s by default,
  `COMPILE_TIMEOUT_MS`) after which the whole process group is killed, and
  container ceilings (`CE_CPUS=4`, `CE_MEM_LIMIT=4g` by default). Both defaults
  come from measurements, not guesses; raise them if you compile large documents.

## Repository layout

```text
ce-gateway-module/   CE WebModule: /api/ai/* gateway + sidebar (pug/js), baked into the image
services/ai-sidecar/ providers (Ollama/OpenAI/compat), SSRF guard, proposal validation
infra/docker/        Dockerfile.ce (CE + TeX bundle + hardening), docker-compose.yml
infra/ollama-bridge/ opt-in loopback bridge for native Docker Engine hosts
scripts/             up/down/doctor/backup/restore/ollama-bridge
qa/g1,g4,g2          measured probes (Playwright) used for the gate reports
tests/fixtures/      synthetic IEEE fixture (no real papers)
docs/                threat model, upstream lock, support matrix
```

## Licensing and provenance

- This project is distributed under **AGPL-3.0** (see `LICENSE`) because it is a
  derivative work of Overleaf CE, which is AGPL-3.0.
- Upstream: Overleaf Community Edition 6.3.2, pinned by image digest
  `sha256:ada39211c54a1e748065834ec44d3a49094cc475c28d8b803a251901592a94b2`
  (plus the `linux/amd64` manifest digest). See `docs/UPSTREAM_LOCK.md`.
- Corresponding source: the pinned official image contains the readable service
  sources (`/overleaf/services/...`), and this repository contains everything we
  add. The image's own OCI label names a revision that is **not** reachable in the
  public GitHub repository, so we do not claim a GitHub-commit provenance — the
  digest is the anchor.
- Overleaf and the Overleaf logo are trademarks of Overleaf. This project uses
  neither, and does not imply endorsement.

## Known issues (v0.1)

- `openin_any` no longer protects reads in TeX Live 2026 (upstream change).
- Rebuilds are capability-reproducible, not byte-reproducible, for the TeX tree.
- The compose stack is verified only on the reference server above.
- The visual check is an on-page A/B (our injected node present vs removed) with
  the caret and animations frozen; a diff against an independently built pristine
  CE image is still **not** measured.

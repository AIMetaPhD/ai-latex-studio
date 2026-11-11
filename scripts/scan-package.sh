#!/usr/bin/env bash
# Check a delivery archive the way a release should be checked: paths AND content.
#
#   bash scripts/scan-package.sh dist/ai-latex-studio-<sha>.tar.gz
#
# Why this exists (measured 2026-11-03): packaging used to verify only entry NAMES
# (".env? artifacts? backups? node_modules?"). A content grep of a real package then
# hit the release gate's own endpoint rule inside scripts/scan-secrets.sh -- the file
# written to keep private detail out of the release was the line in the release that
# named it. Path checks cannot see that class at all.
#
# And why the content check delegates: writing a second inline grep would have put the
# site markers back into tracked prose -- which is exactly what happened the first time
# this was documented. So this script hands the extracted tree to scan-secrets.sh and
# keeps no patterns of its own.
set -uo pipefail
cd "$(dirname "$0")/.."
TARBALL="${1:?usage: scan-package.sh <delivery.tar.gz>}"
[[ -f "$TARBALL" ]] || { echo "ERROR: $TARBALL not found" >&2; exit 2; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "== 1. entry names =="
# `.env` with a real value must never ship; `.env.example` (placeholders, tracked on
# purpose) must not be reported either -- the first draft of this check flagged it,
# which is how a path filter turns into noise people learn to ignore.
bad_names=$(tar -tzf "$TARBALL" | grep -iE '(^|/)\.env$|(^|/)\.env\.[a-z0-9-]+$|credentials|/artifacts/|(^|/)backups/|node_modules|(^|/)dist/|(^|/)trial-login' | grep -viE '\.example$' || true)
if [[ -n "$bad_names" ]]; then
  echo "FAIL: the archive carries paths that must never ship:"; echo "$bad_names" | sed 's/^/  /'
  exit 1
fi
echo "ok: no .env / credentials / artifacts / backups / node_modules / dist / trial-login paths"

echo "== 2. extract =="
tar -xzf "$TARBALL" -C "$WORK" || { echo "ERROR: cannot extract $TARBALL" >&2; exit 1; }
ROOT=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)
[[ -n "$ROOT" && -f "$ROOT/scripts/scan-secrets.sh" ]] || { echo "ERROR: extracted tree has no scripts/scan-secrets.sh -- not a package I recognise" >&2; exit 1; }
echo "ok: extracted to $ROOT"

echo "== 3. content, using the same gate the repo is gated by =="
# scan-secrets.sh reads tracked files through git grep, so the extracted tree needs a
# commit. It runs in the temp copy; nothing here touches this repo.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
(
  cd "$ROOT" && git init -q . >/dev/null 2>&1
  cd "$ROOT" && git add -A >/dev/null 2>&1
  cd "$ROOT" && git -c user.email=scan@local -c user.name=scan commit -qm package >/dev/null 2>&1
)
# Site patterns are deliberately NOT in the archive (that was the leak), so hand the
# gate its operator-owned rules; if they are missing here, the gate must fail closed --
# an unverified package must not be reported as clean.
SITE_SRC="${AILS_SCAN_SITE_RULES:-scripts/scan-secrets.local.sh}"
if [[ ! -f "$SITE_SRC" ]]; then
  echo "WARN: no site rules file reachable ($SITE_SRC); scan-secrets.sh will exit INCOMPLETE (correct), so this package is NOT cleared."
else
  # absolute, because the gate runs from the extracted copy
  SITE_SRC="$(cd "$(dirname "$SITE_SRC")" && pwd)/$(basename "$SITE_SRC")"
fi
out=$(cd "$ROOT" && AILS_SCAN_SITE_RULES="$SITE_SRC" bash scripts/scan-secrets.sh 2>&1)
rc=$?
echo "$out" | tail -6 | sed 's/^/  /'
if [[ $rc -ne 0 ]]; then
  echo "FAIL: the package does not pass the release gate (exit $rc). Not cleared."
  exit 1
fi
echo "== verdict =="
echo "package passes path check and content gate"

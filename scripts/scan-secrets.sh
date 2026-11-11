#!/usr/bin/env bash
# Release-gate scanner: no secret or private-infrastructure detail may ship in the
# tree (v1.2 X10/X22).
#
# Scope, stated in the output too:
#   default   -> scans the tracked working tree  ("is today's content clean")
#   --history -> scans every reachable revision ("is the history clean")
# A path fixed or deleted today is STILL REACHABLE in earlier commits, so a clean
# tree never implies a clean history. Public release requires --history clean as
# well (or a fresh orphan-root import).
#
# What --history does NOT cover, measured 2026-11-03: "reachable" means
# `git rev-list --all`, i.e. everything a ref can reach. Objects dropped by a
# rebase, amend or reset stay in the object database and are invisible to this scan
# -- on this repo `git fsck --unreachable` found 15 such commits, every one of them
# still containing the pre-fix private-endpoint text. `git push` and `git archive`
# do not carry unreachable objects, so the exposure is a copy of `.git` itself;
# clearing it needs `git gc --prune=now` (irreversible, owner's call).
# `--all` therefore means reachable commits UNIONED with the unreachable ones fsck
# finds, and the run reports how many unreachable commits it looked at -- that is the
# number the operator needs before deciding whether to prune.
#
# The site-specific half of the endpoint rule is NOT in this file. It lives in an
# operator-owned, gitignored `scripts/scan-secrets.local.sh` so the shipped repo does
# not name the deployment's own addresses -- measured: when that pattern sat here,
# this script was the one content hit in the delivery package. Without the file this
# run prints INCOMPLETE and exits 2; it never prints a bare "clean".
#
# `scan()` is called through a command substitution (`hits=$(scan ...)`), i.e. in a
# SUBSHELL, so anything it assigns to a global is lost when it returns. Anything a run
# needs to report afterwards must therefore be computed outside scan() -- measured the
# hard way: the unreachable-commit list was built inside scan() and the summary line
# then printed "0 unreachable" while the scan had actually used 19 of them.
#
# usage: scripts/scan-secrets.sh [--history|--all] [--verbose]
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=tree
VERBOSE=0
for a in "$@"; do
  case "$a" in
    --history) MODE=history ;;
    --all) MODE=all ;;
    --verbose) VERBOSE=1 ;;
    *) echo "usage: $0 [--history|--all] [--verbose]"; exit 2 ;;
  esac
done

# Fail CLOSED on the substrate itself. Every rule here reads through `git grep`/
# `git log`, so in a directory that is not a repo (or a repo whose history cannot be
# enumerated) each rule returns the empty string and the run prints "clean" for a
# scan that examined nothing at all. Measured 2026-11-04: a scratch directory holding
# `password: "<literal>"` and an `sk-` key reported `clean (tree)`, exit 0.
# This gate is what stands between "we looked" and "we may publish", so it has to say
# loudly when it could not look.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "scan-secrets: INCOMPLETE -- $(pwd) is not a git repository." >&2
  echo "              Every rule reads through git, so nothing was examined." >&2
  echo "              Run this from the repository root (scripts/scan-secrets.sh)." >&2
  exit 2
fi
if [[ "$MODE" != tree ]] && ! git rev-list --all >/dev/null 2>&1; then
  echo "scan-secrets: INCOMPLETE -- commit history could not be enumerated." >&2
  exit 2
fi

SELF="scripts/$(basename "$0")"
fail=0
findings_total=0

# fsck is run ONCE per --all run, outside scan(), and its output parked in a temp file:
# 11 rules x a full object-database walk is pure waste, and a subshell cannot report
# it back anyway.
# `set -u` is on and a failing mktemp must abort, not silently scan 0 commits.
UNREACHABLE_LIST=''
FS_UNREACHABLE=0
if [[ "$MODE" == all ]]; then
  UNREACHABLE_LIST=$(mktemp) || { echo "ERROR: cannot create the unreachable-object list" >&2; exit 2; }
  trap 'rm -f "$UNREACHABLE_LIST"' EXIT   # MSG_FILE is added to this trap below;
  # a SECOND trap would replace this one and leak both temp files (measured before).
  git fsck --no-reflogs --unreachable 2>/dev/null | awk '/unreachable commit/{print $3}' > "$UNREACHABLE_LIST"
  FS_UNREACHABLE=$(grep -c . "$UNREACHABLE_LIST" || true)
fi

# Commit messages, dumped ONCE for the same subshell reason as above. `git grep`
# reads file contents per revision, so it structurally cannot see a message; a
# push carries messages anyway. Lines are prefixed with the commit so a hit says
# which message to fix.
# An empty dump must not read as "messages are clean": if the walk fails, say so.
MSG_FILE=''
MSG_COMMITS=0
MSG_FAIL=0
if [[ "$MODE" != tree ]]; then
  MSG_FILE=$(mktemp) || { echo "ERROR: cannot create the commit-message buffer" >&2; exit 2; }
  if git log --all --format='commit %H%n%B%n' > "$MSG_FILE" 2>/dev/null; then
    MSG_COMMITS=$(git rev-list --all --count 2>/dev/null || echo 0)
    # MEASURED 2026-11-04: `git log --all` EXITS 0 on a repository with zero commits
    # (this git version), so MSG_FAIL stays 0 and a --history run over 0 commits
    # printed "clean (history)". Same vacuous-clean class as the non-repo case.
    # A history gate that scanned no history is not a clearance.
    [[ "$MSG_COMMITS" -eq 0 ]] && MSG_FAIL=1
  else
    MSG_FAIL=1
  fi
  [[ "$MODE" == all && -s "$UNREACHABLE_LIST" ]] && while read -r r; do
    git log -1 --format='commit %H%n%B%n' "$r" >> "$MSG_FILE" 2>/dev/null || true
  done < "$UNREACHABLE_LIST"
fi

# Per-rule scan errors. scan() runs inside a command substitution, so it cannot set a
# variable in this shell; a file survives the subshell boundary. Any entry here means a
# rule did not actually run, which must not be reported as "no findings".
SCAN_ERRORS=$(mktemp) || { echo "ERROR: cannot create the scan-error buffer" >&2; exit 2; }
# NO trap here: the single EXIT trap is installed with $ST below. A second trap
# replaces the first (measured earlier in this file's history) and would leak these.

scan() { # $1 = ERE, $2 = "case" for a case-SENSITIVE scan; emits matches for the selected scope
  local flags=(-nE -I)
  # -i is what makes the credential words match Password/PASSWORD/API_KEY. It also
  # destroys any [[:upper:]] class in a pattern, so a rule that has to tell an ALL
  # CAPS dotenv name apart from a camelCase identifier asks for no -i. (-I = skip
  # binary files, which stays on either way.)
  [[ "${2:-}" == case ]] || flags+=(-i)
  # Commit MESSAGES are in scope too, and `git grep <rev>` cannot see them -- it
  # reads file contents per revision. Measured 2026-11-04: a message in this repo
  # names a private-infrastructure marker while every file in that same revision
  # is clean, so a file-only scan reports nothing and the string still travels on
  # `git push`. Messages are scanned by reading %B per revision (see commit_msgs()).
  # git grep exits 0 (matches), 1 (no match) and >=2 (ERROR: bad ERE, broken repo).
  # `|| true` collapsed all three into "no hits", so an invalid pattern scanned CLEAN.
  # Errors are now recorded to a file (a subshell cannot set a variable in the caller)
  # and the run refuses to report clean. No matches still means no matches.
  local out rc
  if [[ "$MODE" == tree ]]; then
    out=$(git grep "${flags[@]}" -e "$1" -- . 2>/dev/null); rc=$?
    (( rc >= 2 )) && printf '%s\n' "$1" >> "$SCAN_ERRORS"
    printf '%s' "$out"
    return 0
  fi
  # history / all. --all = reachable commits UNIONED with the unreachable ones fsck
  # can still find. Measured 2026-11-03: this repo carries 19 such commits (left by
  # amends), and every one of them still holds pre-fix private-endpoint text.
  # --history alone walks straight past them. `git push` and `git archive` do not
  # carry them, so they matter to a .git copy, not to a release -- which is exactly
  # why the operator needs a number before deciding on `git gc --prune=now`.
  # Read from the file scan() cannot write to: see the subshell note at the top.
  local revs
  revs=$(git rev-list --all 2>/dev/null) || return 0
  if [[ "$MODE" == all && -s "$UNREACHABLE_LIST" ]]; then
    revs=$(printf '%s\n%s\n' "$revs" "$(cat "$UNREACHABLE_LIST")" | sed '/^$/d' | sort -u)
  fi
  [[ -z "$revs" ]] && return 0
  # suppress the "commit:path:line:content" prefix differences by using -l-free -n
  # shellcheck disable=SC2086
  out=$(git grep "${flags[@]}" -e "$1" $revs -- . 2>/dev/null); rc=$?
  (( rc >= 2 )) && printf '%s\n' "$1" >> "$SCAN_ERRORS"
  printf '%s' "$out"
}

# check <label> <pattern> [whitelist-ERE] [case]
# Whitelist is applied only when non-empty: `grep -vE ''` would be harmless but an
# empty ALTERNATION ('a|') matches everything and would silently mask all findings.
check() {
  local label=$1 pat=$2 allow=${3:-} casesens=${4:-} hits n msghits
  hits=$(scan "$pat" "$casesens")
  # The scanner necessarily contains the patterns it hunts for (canaries, denylists),
  # so drop its own file. In history mode each line is `commit:path:line:content`,
  # so match the path substring rather than an anchored prefix -- an anchored filter
  # silently failed here and made the scanner flag its own test canary.
  # -F: $SELF contains '.', which as a regex would also match other characters.
  # Applied BEFORE the message hits are appended, so it can only drop file hits --
  # its purpose is this file, not every line that mentions it (an independent reviewer's S4: my
  # earlier comment claimed the prefix exempted messages, and that was overstated).
  # Also drop the site-rules files themselves: a rules file necessarily contains the
  # literals it hunts for, so the shipped example (placeholders) would match itself and
  # the operator's real file would be reported as a finding.
  local drop=(-v -F -e "$SELF:" -e "scripts/scan-secrets.local.example:")
  [[ -n "${SITE_RULES_FILE:-}" ]] && drop+=(-e "$SITE_RULES_FILE:")
  hits=$(printf '%s' "$hits" | grep "${drop[@]}" || true)
  # Messages are a second surface, outside git grep's reach: a pattern can match a
  # message that none of that revision's files contain. Same case rule as scan().
  # A flag array local to scan() is NOT usable here (and would abort under set -u).
  if [[ -n "$MSG_FILE" ]]; then
    local mflags=(-nE -I)
    [[ "$casesens" == case ]] || mflags+=(-i)
    msghits=$(grep "${mflags[@]}" -e "$pat" "$MSG_FILE" 2>/dev/null || true)
    # Prefix so a message hit is distinguishable from a file hit in the output, and
    # so the non-verbose grouping (field 2 in revision modes) shows "message" rather
    # than a line number that means nothing to a reader.
    [[ -n "$msghits" ]] && hits+=$'\n'"$(printf '%s\n' "$msghits" | sed 's|^|commit-message:message:|')"
  fi
  if [[ -n "$allow" ]]; then
    # An empty alternative ('a|', '|a', 'a||b') matches EVERYTHING and would silently
    # erase every finding. Refuse the configuration rather than run it.
    if [[ "$allow" == '|'* || "$allow" == *'|' || "$allow" == *'||'* ]]; then
      echo "ERROR: whitelist for '$label' has an empty alternative: $allow" >&2
      exit 2
    fi
    hits=$(printf '%s' "$hits" | grep -vE "$allow" || true)
  fi
  n=$(printf '%s' "$hits" | grep -c . || true)
  findings_total=$((findings_total + n))
  if (( n > 0 )); then
    printf 'HIT  (%3d) %s\n' "$n" "$label"
    if (( VERBOSE )); then
      printf '%s\n' "$hits" | sed 's/^/          /'
    else
      # group by path: field 1 in tree mode (path:line:content), field 2 in EVERY
      # revision mode (commit:path:line:content). Testing == history left --all
      # grouping by commit hash instead of path (an independent reviewer's S6), which is misleading.
      local f=1; [[ "$MODE" != tree ]] && f=2
      printf '%s\n' "$hits" | cut -d: -f"$f" | sort -u | sed 's/^/          /'
      echo "          (rerun with --verbose for line detail)"
    fi
    fail=1
  else
    printf 'clean       %s\n' "$label"
  fi
}

echo "scope: $MODE  (tree = tracked content today; history = every reachable commit)"
if [[ "$MODE" != tree ]]; then
  if [[ "$MSG_FAIL" == 1 ]]; then
    echo "  commit MESSAGES: could NOT be read -- history scan is INCOMPLETE without them"
  else
    echo "  commit MESSAGES: $MSG_COMMITS message(s) in scope (git grep cannot see these)"
  fi
fi
echo

# A literal single-quote, kept in a variable so the patterns below stay readable.
SQ="'"
QUOTED_OPT="[\"$SQ]?"

check "private key material" 'BEGIN [A-Z ]*PRIVATE KEY'
check "OpenAI-style key"     'sk-[A-Za-z0-9]{20,}'
check "GitHub token"         'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}'
check "AWS key id"           'AKIA[0-9A-Z]{16}'
check "Slack token"          'xox[baprs]-[A-Za-z0-9-]{10,}'
# Placeholders and "generate it yourself" instructions are legitimate; only literal
# high-entropy assignments count. A quoted value is unambiguous:
WL='CHANGE_ME|openssl rand|placeholder|example|_EXAMPLE|not-a-real|xxxxxxxx|<[^>]*>|\$\{|\$\(|generate|redact|process\.env|import\.meta'
# A JSON/YAML key is quoted on BOTH sides: `"adminPassword": "x"`. Requiring the
# keyword to sit right next to `:` made every quoted-key form invisible (measured
# 2026-11-03 with a scratch repo: a JSON credential scanned clean). The optional
# closing quote is what closes that hole; the value still has to be a quoted literal.
P_QUOTED="(pass(word|wd)?|secret|token|api[_-]?key)[\"$SQ]?[[:space:]]*[=:][[:space:]]*[\"$SQ][[:alnum:]+./_]{12,}"
check "credential assignment" "$P_QUOTED" "$WL"
# An unquoted value only counts when it mixes letters and digits. Without that
# condition ordinary code reads as a leak: the rule used to make the quote
# optional and flagged `token = document.querySelector` (in qa/g1/14) and
# `password: process.env.X` (throughout history) -- noise in a gate whose whole
# meaning is "a literal secret is about to be published".
P_UNQUOTED="(pass(word|wd)?|secret|token|api[_-]?key)[\"$SQ]?[[:space:]]*[=:][[:space:]]*[[:alnum:]+./_]*[0-9][[:alnum:]+./_]{11,}"
check "credential assignment (unquoted)" "$P_UNQUOTED" "$WL"
# A dotenv line has no colon and no quotes, and its name carries a suffix:
#   SECRET_KEY=ab12cd34ef56gh
# Neither rule above sees it: the keyword `secret` is followed by `_KEY`, not by `=`.
# Matched case-SENSITIVELY on purpose -- an ALL-CAPS assignment name is the dotenv
# convention, while `appSecretValue=` / `tokenizer =` is ordinary code, and a blanket
# rule would light up the SSRF denylist and every config writer in the tree.
P_DOTENV='^[[:space:]]*[A-Z][A-Z0-9_]*(SECRET|TOKEN|KEY|PASS|CRED|AUTH|CERT)[A-Z0-9_]*=[[:alnum:]+./_-]*[0-9][[:alnum:]+./_-]{11,}'
check "credential assignment (dotenv)" "$P_DOTENV" "$WL" case
# The two rules above key on the WORD "password"/"token"/... appearing next to the
# value. A credential assigned to an env-style NAME slipped past both: measured
# 2026-11-03, `const PASS = process.env.AILS_ADMIN_PASS ?? <quoted literal>` (the
# default this commit removes) scanned "clean" in a scratch repo holding exactly
# that file. The name carries the secret here, not the word "password:", so match
# identifiers ending in PASS/PASSWORD/SECRET/TOKEN/KEY assigned a quoted value that
# mixes letters and digits. `x = process.env.Y` has no quote, so ordinary code reads
# still do not match.
P_ENV_STYLE="[[:alnum:]_]*(PASS|PASSWD|PASSWORD|SECRET|TOKEN|KEY)[[:alnum:]_]*[[:space:]]*[=:][[:space:]]*(process[.]env[[:alnum:]_.]*[[:space:]]*(\?\?|\|\|)[[:space:]]*)?[\"$SQ][^\"$SQ]*[0-9][^\"$SQ]{5,}[\"$SQ]"
# The "that is just reading an env var" exemption must NOT apply here: the case the
# gate missed is exactly an env read with a quoted fallback, and the rule already
# requires a quote, so a plain `x = process.env.Y` cannot match it.
WL_LITERAL=${WL//'process\.env|'/}
check "credential literal behind an env-style name" "$P_ENV_STYLE" "$WL_LITERAL"
# Home infrastructure: the queue port/path names our private service and any
# 100.64/10 host is a an internal overlay network detail. The SSRF denylist legitimately carries the
# literal base constant 100.64.0.0 and a CGNAT test value, so only a URL-shaped
# occurrence is treated as a leak.
# SCOPE LIMIT, measured 2026-11-03 (qa/g5/scanner-coverage.mjs): this rule covers the
# ranges THIS deployment uses. It does NOT flag a generic RFC1918 address (10.x,
# 192.168.x, 172.16-31.x). A blanket private-range rule was considered and rejected:
# services/ai-sidecar/src/ssrf.mjs contains ['10.0.0.0', 8] as denylist data, so the
# rule would fire on our own security code and the gate would be trained away from
# reading. If the deployment ever moves onto a LAN address, extend the pattern here --
# do not describe this gate as "no private addresses" in prose.
SITE_RULES_FILE="${AILS_SCAN_SITE_RULES:-scripts/scan-secrets.local.sh}"
GENERIC_ENDPOINT='http[s]?://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'
site_missing=0
if [[ -f "$SITE_RULES_FILE" ]]; then
  # Read as DATA, one assignment -- not sourced. scripts/lib-env.sh exists because
  # `source .env` was measured to execute the file; the same rule applies here, since
  # this path is handed a regex that may have come from a template or a paste.
  SITE_ENDPOINT_RULE=$(sed -n 's/^SITE_ENDPOINT_RULE=//p' "$SITE_RULES_FILE" | head -1)
  if [[ -z "$SITE_ENDPOINT_RULE" ]]; then
    echo "ERROR: $SITE_RULES_FILE exists but carries no SITE_ENDPOINT_RULE= line" >&2
    exit 2
  fi
  check "home network endpoint" "$SITE_ENDPOINT_RULE|$GENERIC_ENDPOINT"
else
  # Fail CLOSED. Without the site file the gate would quietly stop checking the only
  # addresses that matter to this deployment and still print a reassuring "clean".
  site_missing=1
  check "home network endpoint (SITE RULES MISSING -- generic shapes only)" "$GENERIC_ENDPOINT"
fi
# Machine/user identity that must not ship in a public repo.
check "host identity"     'WIN-[0-9A-Z]{6,}'
check "local user paths"  '/home/[a-z0-9_]+/[A-Za-z]|C:\\+Users\\+[^\\ ]+|F:\\+Applications|/mnt/[a-z]/' \
  'node_modules'

# --- self-test ------------------------------------------------------------------
# A scanner that silently matches nothing prints a reassuring "clean". Prove both
# directions: it must catch a planted canary AND keep honouring its whitelist.
ST=$(mktemp -d); trap 'rm -rf "$ST" "${UNREACHABLE_LIST:-}" "${MSG_FILE:-}" "${SCAN_ERRORS:-}"' EXIT
# Assembled at runtime so this file does not itself contain a key-shaped literal
# (GitHub push protection scans text, not shell evaluation).
CANARY="sk-$(printf %s iloetzwstuzqgqlskovqoihi)"
PLACEHOLDER='token: CHANGE_ME_run_openssl_rand'
QUOTED_LITERAL="password: 'Xk9dP2mQ7rL4vB8n'"
UNQUOTED_LITERAL='api_key=7f3a9c1e5b2d'
CODE_LINE='const token = document.querySelector("meta[name=ol-csrfToken]")'
printf '%s\n' "$CANARY" > "$ST/bad.txt"
printf '%s\n' "$PLACEHOLDER" > "$ST/good.txt"
printf '%s\n' "$QUOTED_LITERAL" "$UNQUOTED_LITERAL" > "$ST/lit.txt"
printf '%s\n' "$CODE_LINE" > "$ST/code.txt"
# The shape the gate used to miss, and the ordinary code read it must not flag.
ENV_STYLE_HIT="const PASS = process.env.AILS_ADMIN_PASS ?? 'Xk9dP2mQ7rL4vB8n'"
ENV_STYLE_MISS='const PASS = process.env.AILS_ADMIN_PASS'
printf '%s\n%s\n' "$ENV_STYLE_HIT" "$ENV_STYLE_MISS" > "$ST/envstyle.txt"
# Quoted-key (JSON/YAML) and dotenv shapes, both built from the canaries above so no
# new secret-shaped string is introduced by this file.
JSON_LITERAL=${QUOTED_LITERAL/password:/"adminPassword": }
DOTENV_HIT="APP_SECRET=${UNQUOTED_LITERAL#*=}"
DOTENV_MISS="appSecretValue=${UNQUOTED_LITERAL#*=}"
printf '%s\n' "$JSON_LITERAL" > "$ST/json.txt"
printf '%s\n%s\n' "$DOTENV_HIT" "$DOTENV_MISS" > "$ST/dotenv.txt"
# Fixture integrity FIRST. A negative assertion is only meaningful if its fixture
# exists: `grep -c` on a missing file yields 0, and the negative half *expects* 0 --
# so a missing or truncated fixture made the self-test report ok vacuously, and the
# run then said "clean" on the strength of it. Reproduced 2026-11-04 (raised as S6 in
# an independent reviewer's review): delete only the `good.txt` write, and the run still printed
# `whitelist-holds=ok` plus `clean (tree)`, exit 0.
fixtures=ok
for f in bad good lit code envstyle json dotenv; do
  [[ -s "$ST/$f.txt" ]] || fixtures=FAIL
done
# The two-line fixtures are read with `sed -n 2p`; on a one-line file that yields an
# empty string, and the "must NOT match" half then passes for the wrong reason.
for f in envstyle dotenv; do
  [[ $(grep -c . "$ST/$f.txt" 2>/dev/null || true) -ge 2 ]] || fixtures=FAIL
done
det=$(grep -cE 'sk-[A-Za-z0-9]{20,}' "$ST/bad.txt" || true)
wl=$(grep -E "token[[:space:]]*[=:][[:space:]]*[\"$SQ][A-Za-z0-9+/._-]{12,}" "$ST/good.txt" \
      | grep -vE 'CHANGE_ME|openssl rand' | grep -c . || true)
lit_q=$(grep -ciE "$P_QUOTED" "$ST/lit.txt" || true)
lit_u=$(grep -ciE "$P_UNQUOTED" "$ST/lit.txt" || true)
code_hits=$(grep -ciE "$P_UNQUOTED" "$ST/code.txt" || true)
# same canary, now as a quoted JSON key: the rule used to need the keyword right next
# to the colon, so this was invisible
json_hits=$(grep -ciE "$P_QUOTED" "$ST/json.txt" || true)
# dotenv: ALL-CAPS name must fire, camelCase must not (rule is case-sensitive)
dotenv_hit=$(grep -cE "$P_DOTENV" <(sed -n 1p "$ST/dotenv.txt") || true)
dotenv_miss=$(grep -cE "$P_DOTENV" <(sed -n 2p "$ST/dotenv.txt") || true)
# line 1 is the missed shape, line 2 is ordinary code
env_style_caught=$(sed -n 1p "$ST/envstyle.txt" | grep -E "$P_ENV_STYLE" | grep -vE "$WL_LITERAL" | grep -c . || true)
env_style_missed=$(sed -n 2p "$ST/envstyle.txt" | grep -cE "$P_ENV_STYLE" || true)
[[ "$det" == 1 ]] && pos=ok || pos=FAIL
[[ "$wl" == 0 ]] && neg=ok || neg=FAIL
[[ "$lit_q" -ge 1 && "$lit_u" -ge 1 ]] && lit=ok || lit=FAIL
[[ "$code_hits" == 0 ]] && code=ok || code=FAIL
[[ "$env_style_caught" == 1 ]] && envlit=ok || envlit=FAIL
[[ "$env_style_missed" == 0 ]] && envneg=ok || envneg=FAIL
[[ "$json_hits" -ge 1 ]] && json=ok || json=FAIL
[[ "$dotenv_hit" == 1 && "$dotenv_miss" == 0 ]] && dotenv=ok || dotenv=FAIL
# informational, not a self-test verdict: whether the site half of the endpoint rule
# was active for this run (the exit-2 path below is what enforces it)
site_state=$([[ $site_missing -eq 0 ]] && echo applied || echo absent)
printf '\nself-test  fixtures=%s  detects-canary=%s  whitelist-holds=%s  catches-literals=%s  ignores-code=%s  catches-env-style=%s  ignores-env-read=%s  catches-quoted-key=%s  dotenv-case-split=%s  site-rules=%s\n' \
  "$fixtures" "$pos" "$neg" "$lit" "$code" "$envlit" "$envneg" "$json" "$dotenv" "$site_state"
if [[ "$fixtures" != ok || "$pos" != ok || "$neg" != ok || "$lit" != ok || "$code" != ok || "$envlit" != ok || "$envneg" != ok || "$json" != ok || "$dotenv" != ok ]]; then
  echo "scan-secrets: SELF-TEST FAILED -- results are untrustworthy, refusing to report."
  exit 1
fi

echo
if [[ "$MODE" == all ]]; then
  echo "scope: all = $(git rev-list --all --count) reachable commits + $FS_UNREACHABLE unreachable (fsck) commit(s)"
  [[ "$FS_UNREACHABLE" -gt 0 ]] && echo "  note: unreachable objects are invisible to --history and to push/archive;"
  [[ "$FS_UNREACHABLE" -gt 0 ]] && echo "        clearing them needs 'git gc --prune=now' (irreversible, owner's call)."
fi
if (( fail )); then
  echo "scan-secrets: $findings_total finding(s). Public release is BLOCKED until triaged."
  [[ "$MODE" == tree ]] && echo "  (tree-clean is not enough: also run 'scripts/scan-secrets.sh --history')"
  exit 1
fi
# Fail CLOSED, and say so before anything can be read as a clearance: with the site
# file absent the private-infrastructure half of the gate never ran, so "clean" would
# be a statement about a weaker scan than the one a release depends on.
# Same fail-closed reasoning as the site rules: if messages could not be read, a
# clean result is a statement about a weaker scan than was asked for.
if [[ "$MODE" != tree && "$MSG_FAIL" == 1 ]]; then
  echo
  echo "scan-secrets: INCOMPLETE -- commit messages could not be read, or history was empty."
  echo "              A message can carry a secret that no file in the same revision"
  echo "              contains, and 'git push' ships it anyway. A history scan that saw"
  echo "              0 commits examined no history. Either way: not a clearance."
  exit 2
fi
# A rule that ERRORED did not produce a result, so "0 findings" for it is not a
# statement that the pattern is absent. Placed after the BLOCKED branch on purpose:
# real findings are the stronger verdict and must not be downgraded to INCOMPLETE.
SCAN_ERROR_COUNT=$(grep -c . "$SCAN_ERRORS" 2>/dev/null || true)
if [[ "$SCAN_ERROR_COUNT" -gt 0 ]]; then
  echo
  echo "scan-secrets: INCOMPLETE -- $SCAN_ERROR_COUNT rule(s) errored and produced no result."
  echo "              'git grep' exits 1 for no match and >=2 for an error (128 on this git"
  echo "              version for a bad pattern); the latter used to be read as 'no match'."
  echo "              Failed patterns (first 3):"
  sed -n '1,3p' "$SCAN_ERRORS" | sed 's/^/                /' >&2
  exit 2
fi
if (( site_missing )); then
  echo
  echo "scan-secrets: INCOMPLETE -- site rules file absent ($SITE_RULES_FILE)."
  echo "              Private-infrastructure patterns were NOT applied; this is not a clearance."
  echo "              cp scripts/scan-secrets.local.example scripts/scan-secrets.local.sh  (gitignored)"
  echo "              or set AILS_SCAN_SITE_RULES=/path/to/rules."
  exit 2
fi
echo "scan-secrets: clean ($MODE)"
[[ "$MODE" == tree ]] && echo "  NOTE: history was NOT checked here; run with --history before going public."
exit 0

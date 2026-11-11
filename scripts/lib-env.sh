#!/usr/bin/env bash
# Load KEY=value from an env file WITHOUT executing it.
#
# `set -a; source .env` runs anything the file contains: measured 2026-11-03,
# a line `CANARY=$(touch /tmp/ails-canary-file)` inside a .env created that file
# while doctor.sh was "just reading" it. A .env is data that may come from a
# template, a paste, or a tool; it must not be a code path.
#
# Rules, kept identical to the inline version this replaces:
#  - never clobber a variable the caller already exported (the QA harnesses run
#    these scripts against an isolated project with its own port and prefix);
#  - tolerate `export KEY=value`, quotes, and CRLF line endings;
#  - skip comments and anything that is not a plain KEY=value assignment.
#
# shellcheck disable=SC2034
load_env_file() {
  local file="${1:-.env}" line key val
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line=${line#export }
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then val=${val:1:${#val}-2}; fi
    [[ -n "${!key-}" ]] && continue
    export "$key=$val"
  done < "$file"
}

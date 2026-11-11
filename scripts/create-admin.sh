#!/usr/bin/env bash
# Create the first (admin) account and prove it can log in.
#
# CE 6.3.2 community has no first-run admin UI: /launchpad does not exist and
# /register renders "contact the admin" with no form or POST route (both checked
# in the image). Until now the only way to get an account was to write to Mongo
# by hand, which is not a reproducible install path for someone who has never
# seen Docker. This is that path.
#
#   bash scripts/create-admin.sh you@example.com [--password '...'] [--force]
#
# Without --password a random one is generated and printed exactly once.
# Refuses to add a second account unless --force (it will not touch existing
# accounts either way).
set -euo pipefail
cd "$(dirname "$0")/.."
# .env is loaded without executing it -- see scripts/lib-env.sh for why.
. "$(dirname "$0")/lib-env.sh"
load_env_file .env
PREFIX="${AILS_PREFIX:-ails}"
CE="$PREFIX-ce"
MONGO="$PREFIX-mongo"

EMAIL="${1:-}"
# The address goes into a JavaScript string literal below, so the shape has to be
# checked by whitelist rather than "has an @ and a dot": a quote, backtick or `$`
# in the argument breaks -- or rewrites -- the mongosh statement.
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "usage: create-admin.sh you@example.com [--password '...'] [--force]" >&2; exit 2; }
shift || true
PASSWORD=''
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

docker inspect "$CE" >/dev/null 2>&1 || { echo "ERROR: container $CE not found — run scripts/up.sh first" >&2; exit 1; }
docker inspect "$MONGO" >/dev/null 2>&1 || { echo "ERROR: container $MONGO not found" >&2; exit 1; }

users=$(docker exec "$MONGO" mongosh --quiet sharelatex --eval 'db.users.countDocuments({})')
if [[ "$users" -gt 0 && "$FORCE" != 1 ]]; then
  echo "ERROR: $users account(s) already exist. Refusing to add another without --force." >&2
  echo "       Existing accounts:" >&2
  docker exec "$MONGO" mongosh --quiet sharelatex --eval 'db.users.find({},{"emails.email":1,_id:0}).forEach(u=>print("  "+(u.emails&&u.emails[0]?u.emails[0].email:"(no email)")))' >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
  GENERATED=1
else
  GENERATED=0
fi
[[ ${#PASSWORD} -ge 10 ]] || { echo "ERROR: password must be at least 10 characters" >&2; exit 1; }

# Hash with the same library CE itself uses, inside the image that has it.
HASH=$(docker exec -w /overleaf/services/web "$CE" node --require /overleaf/.pnp.cjs -e \
  "const b=require('bcrypt');process.stdout.write(b.hashSync(process.argv[1],10))" "$PASSWORD")
[[ "$HASH" == \$2* ]] || { echo "ERROR: could not hash the password" >&2; exit 1; }

# CE's analytics code throws on login if the user has no analyticsId
# ("bug: include db.users.analyticsId in projection" -> HTTP 500), which is how
# this was found: the first hand-built account could not log in.
ANALYTICS_ID=$(docker exec "$CE" node -e 'process.stdout.write(crypto.randomUUID())')

DOMAIN="${EMAIL#*@}"
REVERSED=$(printf '%s' "$DOMAIN" | awk -F. '{for(i=NF;i>0;i--){printf "%s%s",$i,(i>1?".":"")}}')

docker exec -i "$MONGO" mongosh --quiet sharelatex >/dev/null <<JS
const email = '${EMAIL}'
const doc = {
  email,
  emails: [{ email, reversedHostname: '${REVERSED}', primary: true, createdAt: new Date() }],
  hashedPassword: '${HASH}',
  first_name: 'Admin',
  last_name: 'User',
  isAdmin: true,
  signUpDate: new Date(),
  lastLogin: null,
  analyticsId: '${ANALYTICS_ID}',
  features: {},
}
db.users.deleteMany({ emails: { \$elemMatch: { email } } })
db.users.insertOne(doc)
print('inserted')
JS

echo "created: $EMAIL (admin)"
if [[ "$GENERATED" == 1 ]]; then
  echo "password: $PASSWORD"
  echo "  (shown once — store it now; re-run with --password to set a specific one)"
fi

# Prove it works rather than assuming: log in over HTTP and fetch /project.
BASE="http://${OVERLEAF_LISTEN_IP:-127.0.0.1}:${OVERLEAF_PORT:-8080}"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
csrf=$(curl -s -c "$JAR" "$BASE/login" | sed -n 's/.*name="_csrf"[^>]*value="\([^"]*\)".*/\1/p' | head -1)
[[ -n "$csrf" ]] || { echo "WARN: could not read the login form; the account was created but is not verified" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" \
  --data-urlencode "_csrf=$csrf" --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD" \
  "$BASE/login")
project=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/project")
if [[ "$code" == 302 && "$project" == 200 ]]; then
  echo "verified: login 302 -> /project 200"
else
  echo "ERROR: account created but login check failed (login=$code project=$project)" >&2
  exit 1
fi

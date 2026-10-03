#!/usr/bin/env bash
# Runs on the staging server, from the deploy directory, after the deploy job has copied the
# compose file, Caddyfile and .env next to it. Safe to re-run by hand: `./deploy.sh`.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -f docker-compose.staging.yml "$@"; }

# Staging is private unless .env says otherwise on purpose; refuse a missing or unknown mode.
if ! grep -Eqx "BASIC_AUTH=(on|off)" .env; then
  echo "BASIC_AUTH in .env must be exactly on or off" >&2
  exit 1
fi

echo "==> Pulling images"
compose --profile jobs pull --quiet

echo "==> Starting database"
compose up -d --wait postgres

echo "==> Applying migrations (prisma migrate deploy)"
compose run --rm migrate

if grep -qx "SEED_DEMO_DATA=true" .env; then
  echo "==> Loading demo data"
  compose run --rm migrate node dist/seed/main.js
fi

echo "==> Starting api, web and caddy"
compose up -d --wait --remove-orphans api web caddy

echo "==> Removing old NOLON images (other projects' images are left alone)"
docker image prune -af --filter label=com.nolon.stack=staging >/dev/null

compose ps

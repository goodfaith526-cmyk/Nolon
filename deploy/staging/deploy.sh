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

# Backups are set up once their settings are in .env (DEPLOY.md, Backups).
backups=0
if grep -Eq "^BACKUP_S3_BUCKET='?[a-z0-9]" .env; then backups=1; fi

echo "==> Pulling images"
compose --profile jobs pull --quiet --ignore-buildable

echo "==> Building the backup tools image"
compose --profile jobs build --quiet backup

echo "==> Starting database"
compose up -d --wait postgres

# Migrations that rewrite existing rows (not only add): applied only with a backup taken just before,
# and with api and web stopped from before the migration until the new ones start, so no old code
# writes in between (AGENTS.md rule 4; docs/reviews/lcl-numbering-capacity-plan-2026-10-27.md, F111-5).
REWRITING_MIGRATIONS=(20261027235016_route_numbers_renumbering)

# Sets `rewrites` to the rewriting migrations not applied yet to this database (none on an empty
# one: no table yet). Run in this shell, not in $(...), so a failed query stops the deploy (set -e)
# and never counts as "nothing pending".
rewrites=""
find_pending_rewrites() {
  local q='SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL'
  local exists applied name
  exists=$(compose exec -T postgres psql -U nolon -d nolon -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")
  [ "$exists" = t ] || return 0
  applied=$(compose exec -T postgres psql -U nolon -d nolon -tAc "$q")
  for name in "${REWRITING_MIGRATIONS[@]}"; do
    grep -qx "$name" <<<"$applied" || rewrites="$rewrites $name"
  done
}

find_pending_rewrites
if [ -n "$rewrites" ]; then
  if [ "$backups" != 1 ]; then
    echo "These migrations rewrite existing data and need staging backups set up first" \
      "(DEPLOY.md, Backups): $rewrites" >&2
    exit 1
  fi
  echo "==> Stopping api and web: these migrations rewrite existing data: $rewrites"
  compose stop api web
fi

# With backups set up, every migration runs right after a fresh, verified, locked off-server
# backup, and a failed backup stops the deploy before anything changes. Without them staging still
# deploys (it ran without backups before), with a warning on every deploy.
if [ "$backups" = 1 ]; then
  echo "==> Backup before migrations"
  ./backup.sh pre-migrate
else
  echo "WARNING: staging backups are not set up; migrating without a backup (DEPLOY.md, Backups)" >&2
fi

echo "==> Applying migrations (prisma migrate deploy)"
compose run --rm migrate

if grep -qx "SEED_DEMO_DATA=true" .env; then
  echo "==> Loading demo data"
  compose run --rm migrate node dist/seed/main.js
fi

echo "==> Starting api, web and caddy"
compose up -d --wait --remove-orphans api web caddy

if [ "$backups" = 1 ]; then
  ./backup.sh install-cron
fi

echo "==> Removing old NOLON images (other projects' images are left alone)"
docker image prune -af --filter label=com.nolon.stack=staging >/dev/null

compose ps

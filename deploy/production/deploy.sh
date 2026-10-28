#!/usr/bin/env bash
# Runs on the server, from ~/nolon-production, after the deploy job has copied the compose file,
# Caddyfile and .env next to it. Safe to re-run by hand: `./deploy.sh`.
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -f docker-compose.production.yml "$@"; }

# Production never loads demo data; refuse an .env that asks for it.
if grep -q "^SEED_DEMO_DATA=" .env; then
  echo "SEED_DEMO_DATA must not be set in production" >&2
  exit 1
fi

# Backups are set up once their settings are in .env (DEPLOY-PRODUCTION.md, Backups).
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
REWRITING_MIGRATIONS=(20261027235015_legacy_booking_numbers 20261027235016_route_numbers_renumbering)

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

# The backup below is required for every migration here; a rewriting one also stops api and web.
find_pending_rewrites
if [ -n "$rewrites" ]; then
  echo "==> Stopping api and web: these migrations rewrite existing data: $rewrites"
  compose stop api web
fi

# Every migration runs right after a fresh, verified, locked off-server backup. On a database that
# holds anything, a deploy without backups set up, or with a failed backup, stops here before
# anything changes. Only the very first deploy, onto an empty database, has nothing to back up.
echo "==> Backup before migrations"
./backup.sh pre-migrate

echo "==> Applying migrations (prisma migrate deploy)"
compose run --rm migrate

echo "==> Branches and the first Administrator (no demo data)"
compose run --rm migrate node dist/seed/base-main.js

echo "==> Starting api, web and caddy"
compose up -d --wait --remove-orphans api web caddy

if [ "$backups" = 1 ]; then
  ./backup.sh install-cron
fi

# Old images are removed by the staging deploy (label com.nolon.stack=staging, shared images);
# images in use by this stack are never removed by that.
compose ps

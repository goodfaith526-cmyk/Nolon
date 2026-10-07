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

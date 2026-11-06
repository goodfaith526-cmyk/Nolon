#!/usr/bin/env bash
# Runs on the staging server, from the deploy directory, after the deploy job has copied the
# compose file, Caddyfile and .env next to it. Safe to re-run by hand: `./deploy.sh`.
set -euo pipefail
cd "$(dirname "$0")"

# --- deploy lock (identical in deploy/staging/deploy.sh and deploy/production/deploy.sh;
# deploy/test-deploy-lock.sh checks both) ---
# One NOLON deploy at a time on this server (staging and production share it, and their images):
# staging's image clean-up must never run while a production deploy is between pulling an image
# and using it. Both stacks deploy as the same user, so they share this lock file. It is held
# until this script exits; a second deploy waits for it (up to 30 minutes).
exec 9> "$HOME/.nolon-deploy.lock"
if ! flock -w 1800 9; then
  echo "Another NOLON deploy has held the server for 30 minutes; try again later." >&2
  exit 1
fi
# The registry login shares the deploy user's Docker config, so it lives inside the lock too:
# `--registry-login USER` (token on stdin, from the deploy job) logs in here and out when this
# script exits, so one deploy's logout can never remove a waiting deploy's login (Codex F183-1).
# Run by hand without it, the existing login is used.
if [ "${1:-}" = --registry-login ]; then
  [ -n "${2:-}" ] || { echo "usage: deploy.sh --registry-login USER < token" >&2; exit 1; }
  trap 'docker logout ghcr.io > /dev/null 2>&1 || true' EXIT
  docker login ghcr.io -u "$2" --password-stdin
fi
# --- end deploy lock ---

# Feature switches set by hand on the server live in switches.env, next to .env. The deploy job
# rewrites .env on every deploy and never touches switches.env, so a switch stays as set until it
# is changed there. Only CS_* settings, the billing switches of plan 12, the window switches of
# plan 13 and comments are accepted:
# it cannot override an image, a password or anything else the deploy job writes.
env_files=(--env-file .env)
if [ -f switches.env ]; then
  # grep reads the file itself (no pipe, so no SIGPIPE): 1 means no other line; 0 (a line that
  # is not allowed) or 2 (unreadable) stops the deploy.
  status=0
  grep -Evxq '[[:space:]]*(#.*)?|CS_[A-Z0-9_]+=.*|(BILLING_AUTO_APPROVE_ENABLED|HANDOVER_PAYMENT_GATE_ENABLED|WINDOW_DESK_ENABLED)=(true|false)' switches.env || status=$?
  if [ "$status" -ne 1 ]; then
    echo "switches.env must be readable and hold only CS_* settings, the plan 12 billing switches, the plan 13 window switches and comments" >&2
    exit 1
  fi
  env_files+=(--env-file switches.env)
fi

compose() { docker compose "${env_files[@]}" -f docker-compose.staging.yml "$@"; }

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

# 20261027235016 failed on staging on 2026-10-28 (bookings still numbered NOL-BK-...) and changed
# nothing (one transaction), but Prisma keeps it as failed and applies nothing after it. Marked
# rolled back here, it applies again, after 20261027235015 that fixes those bookings. Only this
# migration, and only while it is recorded as failed: any other failed migration still stops here.
RETRY_FAILED_MIGRATIONS=(20261027235016_route_numbers_renumbering)
retry_failed_migrations() {
  local exists failed name
  exists=$(compose exec -T postgres psql -U nolon -d nolon -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")
  [ "$exists" = t ] || return 0
  failed=$(compose exec -T postgres psql -U nolon -d nolon -tAc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
  for name in "${RETRY_FAILED_MIGRATIONS[@]}"; do
    if grep -qx "$name" <<<"$failed"; then
      echo "==> Marking the failed $name as rolled back, to apply it again"
      compose run --rm migrate node node_modules/prisma/build/index.js migrate resolve --rolled-back "$name"
    fi
  done
}
retry_failed_migrations

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

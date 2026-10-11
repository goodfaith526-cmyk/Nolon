#!/usr/bin/env bash
# Encrypted off-server backups of the database. Runs on the server, from ~/nolon-production (or
# ~/nolon-staging: NOLON_STACK=staging in .env); the work happens in the backup container
# (backup-job.sh), so nothing is installed on the host. Settings come from .env
# (DEPLOY-PRODUCTION.md or DEPLOY.md, Backups).
#
#   ./backup.sh keygen         once: makes the backup key pair and shows both halves ONCE. The
#                              private key goes off the server (your password manager); the
#                              public key goes into the PRODUCTION_BACKUP_AGE_RECIPIENT variable.
#   ./backup.sh                a backup now
#   ./backup.sh pre-migrate    what deploy.sh runs before migrations: a backup, which must succeed.
#                              Without backups set up it passes only on an empty database (the
#                              first deploy); anything else is refused.
#   ./backup.sh list           the backups in object storage
#   ./backup.sh restore-test [NAME]
#                              restores a backup (default: the newest) into a throwaway database,
#                              checks it, drops it. Asks for the private key (hidden).
#   ./backup.sh restore NAME --database DB [--replace]
#                              restores a backup into database DB. Asks for the private key.
#   ./backup.sh install-cron   a daily backup at 01:17 UTC, staging at 01:47 (deploy.sh does this
#                              when backups are set up). Log: ~/nolon-<stack>-backup.log
set -euo pipefail
cd "$(dirname "$0")"

stack="$(sed -n "s/^NOLON_STACK='\{0,1\}\([a-z]*\)'\{0,1\}$/\1/p" .env 2> /dev/null || true)"
stack="${stack:-production}"
case "$stack" in
  production) cron_minute=17 ;;
  staging) cron_minute=47 ;;
  *) echo "NOLON_STACK in .env must be production or staging" >&2; exit 1 ;;
esac

compose() { docker compose -f "docker-compose.$stack.yml" "$@"; }

case "${1:-}" in
  keygen)
    [ -t 1 ] || { echo "run keygen in a terminal: it shows the private key once" >&2; exit 1; }
    key="$(compose run --rm -T --no-deps --entrypoint age-keygen backup 2> /dev/null)"
    public="$(printf '%s\n' "$key" | compose run --rm -T --no-deps --entrypoint age-keygen backup -y)"
    echo "Backup PRIVATE key. Copy it now into your password manager, off this server."
    echo "It is not stored anywhere; without it no backup can be restored. Never paste it in a chat."
    echo
    printf '%s\n' "$key" | grep '^AGE-SECRET-KEY-'
    echo
    echo "Public key, for the GitHub variable PRODUCTION_BACKUP_AGE_RECIPIENT:"
    echo "$public"
    exit 0
    ;;
  install-cron)
    line="$cron_minute 1 * * * cd $PWD && ./backup.sh >> \$HOME/nolon-$stack-backup.log 2>&1"
    { crontab -l 2> /dev/null | grep -vF "cd $PWD && ./backup.sh" || true; echo "$line"; } | crontab -
    echo "Daily backup installed: $line"
    exit 0
    ;;
  pre-migrate)
    tables="$(compose exec -T postgres psql -U nolon -d nolon -tAc \
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
    [[ "$tables" =~ ^[0-9]+$ ]] || { echo "pre-migrate: cannot read the database ($tables)" >&2; exit 1; }
    if [ "$tables" = 0 ]; then
      echo "Empty database (first deploy): nothing to back up."
      exit 0
    fi
    if ! grep -Eq "^BACKUP_S3_BUCKET='?[a-z0-9]" .env; then
      echo "Refusing to migrate: the database holds data and backups are not set up" \
        "(DEPLOY-PRODUCTION.md or DEPLOY.md, Backups)." >&2
      exit 1
    fi
    compose run --rm -T backup < /dev/null
    exit 0
    ;;
  restore | restore-test)
    # The private key is read here and handed to the container on stdin: never in a file, an
    # argument or the environment.
    if [ -t 0 ]; then
      read -rsp "Backup private key (AGE-SECRET-KEY-...): " identity
      echo >&2
    else
      IFS= read -r identity || true
    fi
    status=0
    printf '%s\n' "$identity" | compose run --rm -T backup "$@" || status=$?
    unset identity
    if [ "$status" = 0 ] && [ "$1" = restore-test ]; then
      date -u +%FT%TZ > last-restore-test
    fi
    exit "$status"
    ;;
esac

compose run --rm -T backup "$@" < /dev/null

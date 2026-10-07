#!/usr/bin/env bash
# Encrypted off-server backups of the production database. Runs on the server, from
# ~/nolon-production; the work happens in the backup container (backup-job.sh), so nothing is
# installed on the host. Settings come from .env (DEPLOY-PRODUCTION.md, Backups).
#
#   ./backup.sh keygen         once: makes the backup key pair and shows both halves ONCE. The
#                              private key goes off the server (your password manager); the
#                              public key goes into the PRODUCTION_BACKUP_AGE_RECIPIENT variable.
#   ./backup.sh                a backup now (deploy.sh also runs one before every migration)
#   ./backup.sh list           the backups in object storage
#   ./backup.sh restore-test [NAME]
#                              restores a backup (default: the newest) into a throwaway database,
#                              checks it, drops it. Asks for the private key (hidden).
#   ./backup.sh restore NAME --database DB [--replace]
#                              restores a backup into database DB. Asks for the private key.
#   ./backup.sh install-cron   a daily backup at 01:17 UTC (deploy.sh does this when backups
#                              are set up). Log: ~/nolon-production-backup.log
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -f docker-compose.production.yml "$@"; }

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
    line="17 1 * * * cd $PWD && ./backup.sh >> \$HOME/nolon-production-backup.log 2>&1"
    { crontab -l 2> /dev/null | grep -vF "cd $PWD && ./backup.sh" || true; echo "$line"; } | crontab -
    echo "Daily backup installed: $line"
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

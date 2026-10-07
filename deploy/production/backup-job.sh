#!/usr/bin/env bash
# Runs inside the backup container (backup.Dockerfile), started by ./backup.sh on the host. The
# database is reached over the stack's network as PGHOST/PGUSER/PGPASSWORD/PGDATABASE.
#
#   backup-job                     a backup now: pg_dump, encrypted to the public key, uploaded,
#                                  read back and compared, locked, old ones pruned
#   backup-job list                the backups in object storage
#   backup-job restore NAME --database DB [--replace]
#                                  restores a backup into database DB (key on stdin)
#   backup-job restore-test [NAME] restores a backup (default: the newest) into a throwaway
#                                  database, checks it and drops it (key on stdin)
#
# The server can write backups but cannot decrypt them: it holds only the public key. Nothing is
# written unencrypted: pg_dump's output goes straight into age. The server cannot delete them
# either: each backup is locked in COMPLIANCE mode (S3 Object Lock) for BACKUP_KEEP_DAYS, which
# nobody can shorten or lift, not even the bucket owner.
set -euo pipefail

die() {
  echo "backup: $*" >&2
  exit 1
}

for name in BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID \
  BACKUP_S3_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || die "$name is not set (DEPLOY-PRODUCTION.md, Backups)"
done
[[ "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]] || die "BACKUP_AGE_RECIPIENT is not an age public key"
keep_days="${BACKUP_KEEP_DAYS:-35}"
if [[ ! "$keep_days" =~ ^[0-9]+$ ]] || [ "$keep_days" -lt 7 ]; then
  die "BACKUP_KEEP_DAYS must be 7 or more"
fi
# The storage keys are sent to this endpoint: plain http only to this machine itself (tests).
endpoint="${BACKUP_S3_ENDPOINT%/}"
if [[ ! "$endpoint" =~ ^https://[^/]+$ ]] &&
  [[ ! "$endpoint" =~ ^http://(127\.0\.0\.1|localhost|s3test)(:[0-9]+)?$ ]]; then
  die "BACKUP_S3_ENDPOINT must be https://host (no path)"
fi
[[ "$BACKUP_S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "BACKUP_S3_BUCKET is not a bucket name"
region="${BACKUP_S3_REGION:-us-east-1}"
prefix=production

# rclone reads its remote from the environment: no rclone config file with keys on disk.
export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_BACKUP_TYPE=s3
export RCLONE_CONFIG_BACKUP_PROVIDER=Other
export RCLONE_CONFIG_BACKUP_ENDPOINT="$endpoint"
export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BACKUP_REGION="$region"
export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_BACKUP_OBJECT_LOCK_SUPPORTED=true
remote="backup:$BACKUP_S3_BUCKET/$prefix"

backup() {
  local name tmp local_sum remote_sum until meta
  name="nolon-$prefix-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
  until="$(date -u -d "@$(($(date -u +%s) + keep_days * 86400))" +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  echo "==> $(date -u +%FT%TZ) backing up to $remote/$name"
  # pipefail: a failed pg_dump fails the backup even though age got a (truncated) stream.
  pg_dump --format=custom --compress=6 | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" > "$tmp"
  local_sum="$(sha256sum "$tmp" | cut -d' ' -f1)"
  # Uploaded already locked in COMPLIANCE mode until $until: a bucket without Object Lock refuses
  # the upload. An S3 upload appears whole or not at all; it is then read back and compared.
  RCLONE_S3_OBJECT_LOCK_MODE=COMPLIANCE RCLONE_S3_OBJECT_LOCK_RETAIN_UNTIL_DATE="$until" \
    rclone copyto "$tmp" "$remote/$name" ||
    die "$name could not be uploaded locked; is Object Lock enabled on the bucket?"
  remote_sum="$(rclone cat "$remote/$name" | sha256sum | cut -d' ' -f1)"
  [ "$local_sum" = "$remote_sum" ] || die "the uploaded $name does not match; do not use it"
  meta="$(rclone lsjson --metadata "$remote/$name")"
  [[ "$meta" == *'"object-lock-mode":"COMPLIANCE"'* && "$meta" == *"\"object-lock-retain-until-date\":\"${until%Z}"* ]] ||
    die "$name could not be locked until $until; is Object Lock enabled on the bucket? $meta"
  echo "==> uploaded, verified and locked for $keep_days days: $name ($(stat -c %s "$tmp") bytes)"
  # Older backups are hidden once their lock has ended; the bucket's lifecycle rule removes
  # them for good (DEPLOY-PRODUCTION.md, Backups).
  rclone delete --min-age "${keep_days}d" --include '*.dump.age' "$remote"
  echo "==> backups kept: $(rclone lsf --include '*.dump.age' "$remote" | wc -l)"
}

newest() {
  rclone lsf --include '*.dump.age' "$remote" | sort | tail -n 1
}

read_identity() {
  local identity=""
  IFS= read -r identity || true
  [[ "$identity" =~ ^AGE-SECRET-KEY-1[0-9A-Z]+$ ]] || die "that is not an age private key"
  printf '%s' "$identity"
}

valid_name() {
  [[ "$1" =~ ^nolon-$prefix-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]]
}

db_exists() {
  [ "$(psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]
}

# Downloads NAME, decrypts it with IDENTITY and restores it into the new database TARGET.
# The key goes to age through a pipe (process substitution), never into a file.
restore_into() {
  local name="$1" identity="$2" target="$3"
  createdb "$target"
  echo "==> restoring $name into $target"
  if ! rclone cat "$remote/$name" |
    age --decrypt --identity <(printf '%s\n' "$identity") |
    pg_restore -d "$target" --no-owner --single-transaction --exit-on-error; then
    dropdb "$target"
    die "restore failed (wrong key, or a damaged backup); nothing else was changed"
  fi
}

restore() {
  local name="${1:-}" database="" replace=0
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --database) database="${2:-}"; shift 2 ;;
      --replace) replace=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  valid_name "$name" || die "usage: restore NAME --database DB [--replace] (see ./backup.sh list)"
  # Short enough to leave room for the _restoring_/_before_ suffixes within PostgreSQL's 63.
  [[ "$database" =~ ^[a-z][a-z0-9_]{0,39}$ ]] || die "--database must be a lowercase database name of up to 40 characters"
  local exists=0
  ! db_exists "$database" || exists=1
  if [ "$exists" = 1 ] && [ "$replace" != 1 ]; then
    die "database $database exists; add --replace to swap it out (stop the api first)"
  fi
  local identity stamp staging before
  identity="$(read_identity)"
  stamp="$(date -u +%s)"
  staging="${database}_restoring_$stamp"
  before="${database}_before_$stamp"
  # Always restored into a new database, so the target is untouched until the restore is complete.
  restore_into "$name" "$identity" "$staging"
  # Then swapped in with one transaction: both renames happen or neither does. It fails, changing
  # nothing, while anything is still connected to the target.
  local swap="ALTER DATABASE $staging RENAME TO $database;"
  [ "$exists" != 1 ] || swap="ALTER DATABASE $database RENAME TO $before; $swap"
  if ! psql -d postgres -v ON_ERROR_STOP=1 -q -c "BEGIN; $swap COMMIT;"; then
    dropdb "$staging"
    die "could not swap in the restored database (is the api stopped?); $database is unchanged"
  fi
  echo "==> restored into $database"
  if [ "$exists" = 1 ]; then
    echo "==> the previous $database is kept as $before. Once the restore is checked, drop it:"
    echo "    docker compose -f docker-compose.production.yml exec postgres dropdb -U nolon $before"
  fi
}

# The checks a restored database must pass. Prints one line per check; fails on the first miss.
check_restored() {
  local db="$1" value
  q() { psql -d "$db" -tAc "$1"; }
  value="$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
  [ "$value" -gt 0 ] || die "check: no applied migrations in the restored database"
  echo "ok - applied migrations: $value (live: $(psql -tAc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"))"
  # Posted journal entries are immutable and balanced; a restore must bring both back.
  value="$(q "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
    ('journal_entries_guard', 'journal_lines_guard', 'journal_entries_no_truncate',
     'journal_lines_no_truncate', 'audit_events_append_only', 'audit_events_no_truncate')")"
  [ "$value" = 6 ] || die "check: only $value of 6 immutability triggers were restored"
  echo "ok - immutability triggers restored (6 of 6)"
  value="$(q "SELECT count(*) FROM (SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.status = 'POSTED' GROUP BY e.id
    HAVING sum(l.debit_usd) <> sum(l.credit_usd)) unbalanced")"
  [ "$value" = 0 ] || die "check: $value posted journal entries are not balanced"
  echo "ok - every posted journal entry is balanced"
  value="$(q "SELECT count(*) FROM users WHERE is_active AND id IN
    (SELECT user_id FROM user_roles WHERE role = 'ADMINISTRATOR')")"
  [ "$value" -gt 0 ] || die "check: no active Administrator in the restored database"
  echo "ok - active Administrators: $value"
  local table restored live
  echo "     table                restored      live"
  for table in branches users customers shipments customer_invoices receipts journal_entries journal_lines audit_events; do
    restored="$(q "SELECT count(*) FROM $table")"
    live="$(psql -tAc "SELECT count(*) FROM $table")"
    printf '     %-20s %8s %9s\n' "$table" "$restored" "$live"
  done
}

restore_test() {
  local name="${1:-}" identity
  [ -n "$name" ] || name="$(newest)"
  [ -n "$name" ] || die "there are no backups yet"
  valid_name "$name" || die "usage: restore-test [NAME] (see ./backup.sh list)"
  identity="$(read_identity)"
  # Global, for the trap: the throwaway database is dropped however this ends.
  restore_check_db="restore_check_$(date -u +%s)"
  trap 'dropdb --if-exists "$restore_check_db"' EXIT
  restore_into "$name" "$identity" "$restore_check_db"
  check_restored "$restore_check_db"
  echo "RESTORE TEST PASSED: $name"
}

case "${1:-}" in
  '') backup ;;
  list) rclone lsl --include '*.dump.age' "$remote" | sort -k2,3 ;;
  restore) shift; restore "$@" ;;
  restore-test) shift; restore_test "$@" ;;
  *) die "usage: backup-job [list | restore NAME --database DB [--replace] | restore-test [NAME]]" ;;
esac

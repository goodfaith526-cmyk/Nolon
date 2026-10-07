#!/usr/bin/env bash
# Tests backup.sh end to end with Docker: the real backup image, a PostgreSQL holding every
# migration, and a local S3 server with Object Lock (versitygw) on the stack's network. A backup is
# encrypted, uploaded and locked, then restored and checked. CI runs this; so can anyone with
# Docker. A backup is only as good as a tested restore.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="nolon-backup-test-$$"
s3_name="$COMPOSE_PROJECT_NAME-s3"
s3_port=19000
s3="http://127.0.0.1:$s3_port"
# versitygw v1.8.0, pinned by digest.
s3_image=versity/versitygw@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499

cleanup() {
  docker rm -f "$s3_name" > /dev/null 2>&1 || true
  (cd "$work" && docker compose -f docker-compose.production.yml --profile jobs down -v \
    --remove-orphans > /dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

cp "$here"/{docker-compose.production.yml,backup.sh,backup-job.sh,backup.Dockerfile} "$work/"
cd "$work"
compose() { docker compose -f docker-compose.production.yml "$@"; }

age_key() { compose run --rm -T --no-deps --entrypoint age-keygen backup 2> /dev/null | grep '^AGE-SECRET-KEY-'; }
age_public() { compose run --rm -T --no-deps --entrypoint age-keygen backup -y; }

# .env as the deploy job writes it. set_env replaces one setting.
cat > .env << 'ENV'
SITE_DOMAIN='erp.test'
LOCAL_PORT='18092'
API_IMAGE='unused'
MIGRATE_IMAGE='unused'
WEB_IMAGE='unused'
POSTGRES_PASSWORD='backuptestpassword'
BACKUP_S3_ENDPOINT='http://s3test:9000'
BACKUP_S3_BUCKET='backups'
BACKUP_S3_REGION=''
BACKUP_KEEP_DAYS=''
BACKUP_S3_ACCESS_KEY_ID='test-access'
BACKUP_S3_SECRET_ACCESS_KEY='test-secret-key'
ENV
set_env() {
  grep -v "^$1=" .env > .env.tmp || true
  echo "$1='$2'" >> .env.tmp
  mv .env.tmp .env
}

compose --profile jobs build --quiet backup
backup_key="$(age_key)"
set_env BACKUP_AGE_RECIPIENT "$(printf '%s\n' "$backup_key" | age_public)"

compose up -d --wait postgres > /dev/null 2>&1
psql_in() { compose exec -T postgres psql -U nolon -d "$1" -v ON_ERROR_STOP=1 -tAq -c "$2"; }

# Every migration, as prisma migrate deploy would leave the database.
psql_in nolon "CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
  finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)"
for dir in "$repo"/apps/api/prisma/migrations/*/; do
  compose exec -T postgres psql -U nolon -d nolon -v ON_ERROR_STOP=1 -q < "$dir/migration.sql" > /dev/null
  psql_in nolon "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
    VALUES (gen_random_uuid(), 'test', now(), '$(basename "$dir")', 1)"
done
psql_in nolon "INSERT INTO users (id, email, full_name, password_hash, updated_at)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'admin@nolon.test', 'Admin', 'x', now());
  INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000000a', 'ADMINISTRATOR');
  CREATE TABLE sample (id int PRIMARY KEY, secret_note text);
  INSERT INTO sample SELECT g, 'customer-note-' || g FROM generate_series(1, 500) g;"
pass "database with every migration, an Administrator and sample rows"

docker run -d --name "$s3_name" --network "${COMPOSE_PROJECT_NAME}_default" --network-alias s3test \
  -p "127.0.0.1:$s3_port:9000" -e ROOT_ACCESS_KEY=test-access -e ROOT_SECRET_KEY=test-secret-key \
  --entrypoint sh "$s3_image" -c \
  'mkdir -p /tmp/s3/data /tmp/s3/versions && exec versitygw --port :9000 posix --versioning-dir /tmp/s3/versions /tmp/s3/data' \
  > /dev/null
s3_call() {
  printf 'user = "test-access:test-secret-key"\n' |
    curl -sS --max-time 10 -K - --aws-sigv4 "aws:amz:us-east-1:s3" "$@"
}
for _ in $(seq 1 50); do s3_call -o /dev/null "$s3/" 2> /dev/null && break; sleep 0.2; done
# The bucket as DEPLOY-PRODUCTION.md says to create it: with Object Lock. And one without.
s3_call -fo /dev/null -X PUT -H 'x-amz-bucket-object-lock-enabled: true' "$s3/backups"
s3_call -fo /dev/null -X PUT "$s3/unlocked"

out="$(./backup.sh 2>&1)" || fail "backup failed: $out"
name="$(./backup.sh list | awk '{ print $NF }')"
[[ "$name" =~ ^nolon-production-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]] || fail "expected one backup: $name"
s3_call -fo "$work/object" "$s3/backups/production/$name"
[ -s "$work/object" ] || fail "the backup object is empty"
head -c 40 "$work/object" | grep -q 'age-encryption.org/v1' || fail "the backup is not age-encrypted"
grep -q 'customer-note-' "$work/object" && fail "plain data found in the backup object"
pass "backup is encrypted, uploaded, listed, and holds no plain data"

retention="$(s3_call "$s3/backups/production/$name?retention")"
[[ "$retention" == *"<Mode>COMPLIANCE</Mode>"* ]] || fail "the backup is not locked: $retention"
version="$(s3_call -I "$s3/backups/production/$name" | tr -d '\r' | awk 'tolower($1) == "x-amz-version-id:" { print $2 }')"
[ -n "$version" ] || fail "no version id for $name"
[ "$(s3_call -o /dev/null -w '%{http_code}' -X DELETE "$s3/backups/production/$name?versionId=$version")" = 403 ] ||
  fail "the server's storage key could delete a locked backup"
pass "the backup is locked in COMPLIANCE mode, and the server's key cannot delete it"

set_env BACKUP_S3_BUCKET unlocked
out="$(./backup.sh 2>&1)" && fail "backup succeeded into a bucket without Object Lock"
[[ "$out" == *"is Object Lock enabled on the bucket"* ]] || fail "unexpected failure without Object Lock: $out"
set_env BACKUP_S3_BUCKET backups
pass "a backup that cannot be locked fails"

restore_checks() { psql_in postgres "SELECT count(*) FROM pg_database WHERE datname LIKE 'restore_check_%'"; }
printf '%s\n' "$(age_key)" | ./backup.sh restore-test > /dev/null 2>&1 &&
  fail "restore-test worked with another private key"
[ "$(restore_checks)" = 0 ] || fail "a failed restore-test left its database behind"
[ ! -e last-restore-test ] || fail "a failed restore-test was recorded"
pass "a backup does not open with another key, and the failed restore leaves nothing behind"

out="$(printf '%s\n' "$backup_key" | ./backup.sh restore-test 2>&1)" || fail "restore-test failed: $out"
[[ "$out" == *"RESTORE TEST PASSED: $name"* ]] || fail "restore-test did not pass: $out"
[[ "$out" == *"ok - immutability triggers restored (6 of 6)"* ]] || fail "triggers not checked: $out"
[[ "$out" == *"ok - every posted journal entry is balanced"* ]] || fail "balance not checked: $out"
[ "$(restore_checks)" = 0 ] || fail "restore-test left its database behind"
[ -s last-restore-test ] || fail "a passed restore-test was not recorded"
pass "restore-test restores the newest backup, checks it, records it and drops it"

# A backup with no Administrator in it does not pass.
psql_in nolon "UPDATE users SET is_active = false"
sleep 1 # backup names are per second
./backup.sh > /dev/null 2>&1 || fail "second backup failed"
psql_in nolon "UPDATE users SET is_active = true"
out="$(printf '%s\n' "$backup_key" | ./backup.sh restore-test 2>&1)" &&
  fail "restore-test passed a backup without an Administrator"
[[ "$out" == *"no active Administrator"* ]] || fail "unexpected restore-test failure: $out"
[ "$(restore_checks)" = 0 ] || fail "a failed check left its database behind"
pass "restore-test fails a backup that misses a check, and leaves nothing behind"

printf '%s\n' "$backup_key" | ./backup.sh restore "$name" --database nolon_restored > /dev/null
[ "$(psql_in nolon_restored "SELECT count(*), max(secret_note) FROM sample")" = "500|customer-note-99" ] ||
  fail "restored data differs"
printf '%s\n' "$backup_key" | ./backup.sh restore "$name" --database nolon_restored > /dev/null 2>&1 &&
  fail "restore overwrote an existing database without --replace"
psql_in nolon_restored "DELETE FROM sample WHERE id > 10" > /dev/null
printf '%s\n' "$backup_key" | ./backup.sh restore "$name" --database nolon_restored --replace > /dev/null
[ "$(psql_in nolon_restored "SELECT count(*) FROM sample")" = 500 ] || fail "--replace did not restore"
before="$(psql_in postgres "SELECT datname FROM pg_database WHERE datname LIKE 'nolon_restored_before_%'")"
[ "$(psql_in "$before" "SELECT count(*) FROM sample")" = 10 ] || fail "the previous database was not kept"
pass "restore into a new database, refuses to overwrite, and --replace keeps the previous one"

printf 'not-a-key\n' | ./backup.sh restore "$name" --database nolon_x > /dev/null 2>&1 &&
  fail "restore accepted a malformed key"
./backup.sh restore "../etc/passwd" --database nolon_x < /dev/null > /dev/null 2>&1 &&
  fail "restore accepted a bad backup name"
set_env BACKUP_S3_ENDPOINT http://storage.example.com
out="$(./backup.sh 2>&1)" && fail "backup accepted a plain http endpoint"
[[ "$out" == *"must be https"* ]] || fail "unexpected failure for an http endpoint: $out"
set_env BACKUP_S3_ENDPOINT http://s3test:9000
set_env BACKUP_KEEP_DAYS 5
./backup.sh > /dev/null 2>&1 && fail "backup accepted a retention under 7 days"
set_env BACKUP_KEEP_DAYS ''
set_env BACKUP_AGE_RECIPIENT ''
out="$(./backup.sh 2>&1)" && fail "backup ran without settings"
[[ "$out" == *"BACKUP_AGE_RECIPIENT is not set"* ]] || fail "unexpected failure without settings: $out"
pass "bad keys, names, endpoints, retention and missing settings are refused"

# What deploy.sh runs before every migration.
set_env BACKUP_KEEP_DAYS ''
set_env BACKUP_AGE_RECIPIENT "$(printf '%s\n' "$backup_key" | age_public)"
count_backups() { ./backup.sh list | wc -l; }
before_count="$(count_backups)"
sleep 1 # backup names are per second
out="$(./backup.sh pre-migrate 2>&1)" || fail "pre-migrate failed with backups set up: $out"
[ "$(count_backups)" = $((before_count + 1)) ] || fail "pre-migrate took no backup: $out"
set_env BACKUP_S3_BUCKET unlocked
./backup.sh pre-migrate > /dev/null 2>&1 && fail "pre-migrate passed although the backup failed"
pass "pre-migrate takes a backup, and fails when the backup fails"

set_env BACKUP_S3_BUCKET ''
out="$(./backup.sh pre-migrate 2>&1)" && fail "pre-migrate let a database with data migrate without backups"
[[ "$out" == *"Refusing to migrate"* ]] || fail "unexpected pre-migrate failure without backups: $out"
psql_in postgres "DROP DATABASE nolon WITH (FORCE)"
psql_in postgres "CREATE DATABASE nolon"
out="$(./backup.sh pre-migrate 2>&1)" || fail "pre-migrate refused the first deploy onto an empty database: $out"
[[ "$out" == *"Empty database"* ]] || fail "unexpected pre-migrate output on an empty database: $out"
pass "without backups, only an empty database (the first deploy) may be migrated"

echo "All backup tests passed."

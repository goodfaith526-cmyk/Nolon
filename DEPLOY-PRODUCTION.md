# Production deployment

Production runs on the same Hetzner server as staging, as a separate stack: its own Compose
project `nolon-production` (containers, network and volumes), its own PostgreSQL database, its own
deploy directory `~deploy/nolon-production` and its own local port. Nothing is shared with staging
except the host nginx, the images in GitHub Container Registry and the machine itself. If the load
grows, the same files move to a server of its own unchanged.

```
browser ──https──> host nginx ──> 127.0.0.1:<PRODUCTION_LOCAL_PORT> caddy ──/api/*──> api ──> postgres
                   (TLS, domain)                                        └─ else ──> web
```

Differences from staging:

- **No demo data, ever.** The deploy runs the base seed only (`dist/seed/base-main.js`: the five
  branches and the first Administrator). `ALLOW_DEMO_SEED` is never set, so the demo seed refuses
  to run.
- **No basic auth.** The app's own sign-in protects it.
- **Real client IPs.** Caddy trusts the host nginx and the API runs with `TRUST_PROXY_HOPS=2` and
  the per-IP sign-in limit on (docs/plans/01-auth-and-permissions.md, S1).
- **The staff AI assistant is off.** No assistant button, whatever staging's settings are.
- **Nothing is built for production.** It runs the exact images a commit already ran on staging.
- **Manual and approved.** Only by hand, and the deploy job waits for a reviewer's approval.

## How a deploy runs

Actions > **Deploy production** > Run workflow (branch `main`). Optionally give a full commit SHA of
`main`; empty means the latest commit of `main`.

1. **Check** (no secrets): the commit is on `main`, CI passed on it, **Deploy staging** succeeded
   on it, and its three images exist in GHCR. Any failure stops here.
2. **Approval**: the deploy job waits in the `production` environment until a required reviewer
   approves it. Its secrets are released only then.
3. **Deploy**: writes the server `.env`, copies `deploy/production/` to `~/nolon-production`, and
   runs `deploy.sh` there: pull images, start PostgreSQL, take a backup (once backups are set up),
   `prisma migrate deploy`, base seed, start api/web/caddy and wait until their health checks pass.
4. **Health check**: `https://<PRODUCTION_DOMAIN>/api/v1/health` and the web page answer 200.

### Going back to an earlier version

Run the workflow again with the earlier commit's SHA. That is safe only when no migration was added
in between: migrations only go forward, and older code may not run on a newer schema. When a
migration was added, fix forward with a new commit, or restore the backup taken right before it
(Backups, Restore).

## One-time setup

Server steps run as root in an SSH session on the server, unless they say otherwise. The `deploy`
user, Docker and the host nginx already exist (DEPLOY.md). Nothing here touches staging or the
other projects on the server.

### 1. A deploy key of its own (on your PC)

```sh
ssh-keygen -t ed25519 -N "" -C "github-actions-nolon-production" -f nolon-production-deploy
```

Add the content of `nolon-production-deploy.pub` as a new line in `/home/deploy/.ssh/authorized_keys`
on the server. The private key goes only into the GitHub secret below; never paste it anywhere
else. A separate key means production's access can be revoked without touching staging's.

### 2. The `production` environment (GitHub)

Settings > Environments > New environment > `production`:

- **Required reviewers**: yourself. Every production deploy then waits for your approval.
- **Deployment branches and tags**: Selected branches > `main`.

### 3. Secrets and variables of that environment

In the `production` environment (not the repository-wide secrets), **Environment secrets**:

| Secret                           | Value                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `PRODUCTION_SSH_HOST`            | Server IP, `2.28.12.44`                                                                      |
| `PRODUCTION_SSH_USER`            | `deploy`                                                                                     |
| `PRODUCTION_SSH_PRIVATE_KEY`     | Full content of `nolon-production-deploy` (the private key)                                  |
| `PRODUCTION_SSH_KNOWN_HOSTS`     | The server's host key, as for staging (DEPLOY.md, step 3)                                    |
| `PRODUCTION_POSTGRES_PASSWORD`   | Output of `openssl rand -hex 24`, new, never used anywhere else                              |
| `PRODUCTION_SEED_ADMIN_EMAIL`    | Email of the first production Administrator                                                  |
| `PRODUCTION_SEED_ADMIN_PASSWORD` | 16 or more characters, no `'`, new, never used on staging; change it after the first sign-in |

**Environment variables**:

| Variable                | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `PRODUCTION_DOMAIN`     | The production domain, e.g. `erp.example.com`                                             |
| `PRODUCTION_LOCAL_PORT` | A free local port, not staging's, e.g. `8092`: `ss -tlnp \| grep ':8092 '` prints nothing |

The PostgreSQL password is fixed when the database volume is first created; keep the secret stable.
The seed creates the Administrator only when no user has that email and never changes a password.

### 4. DNS

Point the domain's A record to `2.28.12.44`, at the domain's DNS provider. Check from your PC that
`nslookup <domain>` answers `2.28.12.44` before the next step.

### 5. Host nginx and the certificate

Save as `/etc/nginx/sites-available/nolon-production`, with the real domain and port:

```nginx
server {
    listen 80;
    server_name erp.example.com;
    location / {
        proxy_pass http://127.0.0.1:8092;
        client_max_body_size 25m;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then:

```sh
ln -s /etc/nginx/sites-available/nolon-production /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d erp.example.com
```

After certbot has added the `listen 443 ssl` lines, add `http2 on;` inside that `server` block,
then `nginx -t && systemctl reload nginx` again (staging got the same fix on 2026-10-06).

`X-Forwarded-For` must be set exactly as above: the API takes the client IP from it, through
exactly two trusted hops (nginx, then Caddy).

### 6. First deploy

Actions > Deploy production > Run workflow, then approve the deploy job. Sign in at
`https://<domain>` with the seed Administrator and change the password at once.

## On the server

```sh
cd ~/nolon-production
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs -f api
./deploy.sh        # re-run the last deploy (needs `docker login ghcr.io` if images were pruned)
```

## Backups

Daily at 01:17 UTC, and before every migration, `backup.sh` dumps the database, encrypts the dump
on the server with age, uploads it to S3-compatible object storage under `production/`, reads it
back, compares checksums and checks the lock. The work runs in a small image built on the server
(`backup.Dockerfile`: PostgreSQL 16 client, rclone, age, pinned), so nothing is installed on the
host.

- **The server can write backups but not read them.** It holds only the backup _public_ key. The
  private key is shown once at setup, and you keep it off the server.
- **The server cannot delete backups either.** Each one is uploaded locked with S3 Object Lock in
  COMPLIANCE mode for `BACKUP_KEEP_DAYS` (default 35). Nobody can shorten or lift that lock. A
  bucket without Object Lock refuses the upload, so that is caught on the first run.
- **Nothing is written to disk unencrypted.** pg_dump's output goes straight into age. rclone takes
  its settings from the environment, with no config file. The endpoint must be `https://`.
- **Every migration has a backup right before it.** If backups are set up, a deploy stops when the
  backup before its migrations fails. Until they are set up, each deploy prints a warning, and
  **production must hold no real data.**
- **Restore is tested on every CI run** (`deploy/production/test-backup.sh`) against a local S3
  server with Object Lock: encryption, lock, a key that cannot delete, a wrong key, `restore-test`
  and `restore --replace`.

### Setup, once

1. **Bucket** (Hetzner Console > Object Storage): create a private bucket, e.g.
   `nolon-production-backups`, **with Object Lock enabled** (it can only be chosen at creation).
   Prefer a location other than the server's, so one site's outage does not take both. Add a
   lifecycle rule that deletes noncurrent versions after 1 day, so backups past their lock are
   really removed. Create S3 credentials for it.
2. **Key pair** (server, in `~/nolon-production`, after the first deploy): `./backup.sh keygen`.
   Copy the private key it prints into your password manager; it is stored nowhere else, and
   without it no backup can be restored. Never paste it in a chat or a screenshot.
3. **GitHub** (`production` environment):

   | Kind     | Name                                     | Value                                             |
   | -------- | ---------------------------------------- | ------------------------------------------------- |
   | Variable | `PRODUCTION_BACKUP_AGE_RECIPIENT`        | The public key from `keygen` (starts with `age1`) |
   | Variable | `PRODUCTION_BACKUP_S3_ENDPOINT`          | e.g. `https://hel1.your-objectstorage.com`        |
   | Variable | `PRODUCTION_BACKUP_S3_REGION`            | e.g. `hel1`                                       |
   | Variable | `PRODUCTION_BACKUP_S3_BUCKET`            | The bucket name                                   |
   | Variable | `PRODUCTION_BACKUP_KEEP_DAYS`            | Optional, 7 or more, default 35                   |
   | Secret   | `PRODUCTION_BACKUP_S3_ACCESS_KEY_ID`     | From step 1                                       |
   | Secret   | `PRODUCTION_BACKUP_S3_SECRET_ACCESS_KEY` | From step 1                                       |

4. **Deploy** again. The deploy installs the daily backup (`crontab -l` shows it; log
   `~/nolon-production-backup.log`).
5. **First backup and restore test** (server): `./backup.sh`, then `./backup.sh restore-test`. It
   asks for the private key (hidden as you type), restores the newest backup into a throwaway
   database, checks it (migrations applied, the immutability triggers, every posted journal entry
   balanced, an active Administrator, row counts next to the live ones) and drops it. It must end
   with `RESTORE TEST PASSED`. This is the go-live gate; repeat it monthly. The date of the last
   pass is in `~/nolon-production/last-restore-test`.

### Restore

- `./backup.sh list` shows the backups.
- `./backup.sh restore <name> --database nolon_check` restores into a new database, leaving the
  live one alone.
- To bring back the live database:
  1. Stop the API: `docker compose -f docker-compose.production.yml stop api`.
  2. `./backup.sh restore <name> --database nolon --replace`. The backup is restored into a new
     database first, then swapped in with one transaction; if anything fails, the live database
     is unchanged. The previous one is kept under a `_before_` name, and the command prints how to
     drop it once the restore is checked.
  3. `./deploy.sh`.
- Backups hidden by someone with the server's key stay in the bucket as older versions: from any
  machine with the storage keys, `rclone lsl --s3-versions` lists them and
  `rclone copyto --s3-version-at <time>` brings one back.

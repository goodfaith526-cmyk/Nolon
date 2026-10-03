# Staging deployment

Staging runs on one Hetzner server with Docker Compose: PostgreSQL (persistent volume), the API,
the web app and Caddy (automatic HTTPS from Let's Encrypt, optional basic auth).

```
browser ──https──> caddy ──/api/*──> api:4000 ──> postgres
                         └─ else ──> web:3000
```

## How a deploy runs

`.github/workflows/deploy-staging.yml` runs when CI passes on a push to `main` (or by hand:
Actions > Deploy staging > Run workflow). It:

1. Builds three images and pushes them to GitHub Container Registry, tagged with the commit SHA:
   `api`, `web`, and `migrate` (Prisma CLI + the demo seed, used for one-off jobs).
2. Copies `deploy/staging/` (compose file, Caddyfile, `deploy.sh`) and a generated `.env` to
   `~/nolon-staging` on the server over SSH.
3. Runs `deploy.sh` there: pull images, start PostgreSQL, `prisma migrate deploy`, load demo
   data (idempotent upserts), start api/web/caddy and wait until their health checks pass.
4. Calls `https://<domain>/api/v1/health` from outside and checks the web page answers.

## Address

Default: `https://staging.2-28-12-44.sslip.io` (sslip.io resolves that name to 2.28.12.44, so no
DNS setup is needed). To change it, set the repository **variable** `STAGING_DOMAIN`
(Settings > Secrets and variables > Actions > Variables), e.g. `staging.nolon.example`, and point
that name's A record to the server. Nothing else changes.

## One-time setup

### 1. SSH key for GitHub Actions (on your PC)

```sh
ssh-keygen -t ed25519 -N "" -C "github-actions-nolon-staging" -f nolon-staging-deploy
```

This creates `nolon-staging-deploy` (private key, goes to a GitHub secret only) and
`nolon-staging-deploy.pub` (public key, goes to the server).

### 2. Server (once, as root)

Ubuntu 24.04 is assumed.

```sh
curl -fsSL https://get.docker.com | sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "PASTE THE CONTENT OF nolon-staging-deploy.pub HERE" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
```

Firewall (Hetzner Cloud Firewall or `ufw`):

- **80 and 443 (TCP) and 443 (UDP) open to everyone.** Let's Encrypt must reach port 80/443 to
  issue the certificate.
- **22 open to everyone, key-only.** GitHub-hosted runners have no fixed IP, so limiting SSH to
  your own IP breaks deploys. Turn off password login instead: in `/etc/ssh/sshd_config` set
  `PasswordAuthentication no`, then `systemctl reload ssh`.

Note: members of the `docker` group are effectively root on the server. The `deploy` user exists
so the key in GitHub can be revoked without touching root's access.

### 3. Host key (on your PC)

```sh
ssh-keyscan -t ed25519 2.28.12.44
```

The output line is the `STAGING_SSH_KNOWN_HOSTS` secret. It stops the deploy job from talking to
a different machine pretending to be the server.

### 4. Basic auth password hash (optional)

```sh
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'THE-PASSWORD-YOU-WILL-GIVE-THE-CLIENT'
```

Without both basic-auth secrets the site is public. `/api/v1/health` always stays open so the
deploy job can check it.

### 5. GitHub secrets

Settings > Secrets and variables > Actions > **Secrets** > New repository secret:

| Secret                      | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| `STAGING_SSH_HOST`          | Server IP, e.g. `2.28.12.44`                             |
| `STAGING_SSH_USER`          | `deploy`                                                 |
| `STAGING_SSH_PRIVATE_KEY`   | Full content of `nolon-staging-deploy` (the private key) |
| `STAGING_SSH_KNOWN_HOSTS`   | Output line of step 3                                    |
| `STAGING_POSTGRES_PASSWORD` | Output of `openssl rand -hex 24` (letters/digits only)   |
| `STAGING_BASIC_AUTH_USER`   | Optional, e.g. `nolon`                                   |
| `STAGING_BASIC_AUTH_HASH`   | Optional, output of step 4 (starts with `$2a$`)          |

The PostgreSQL password is set when the database volume is first created. Changing the secret
later does not change the database password; keep it stable.

### 6. First deploy

Actions > Deploy staging > Run workflow. The first run takes longer (no build cache, and Caddy
requests the certificate).

## On the server

```sh
cd ~/nolon-staging
docker compose -f docker-compose.staging.yml ps
docker compose -f docker-compose.staging.yml logs -f api
./deploy.sh        # re-run the last deploy (needs `docker login ghcr.io` if images were pruned)
```

Database backups are not set up yet; staging holds demo data only.

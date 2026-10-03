# Staging deployment

Staging runs on one Hetzner server with Docker Compose: PostgreSQL (persistent volume), the API,
the web app and Caddy (automatic HTTPS from Let's Encrypt, basic auth in front of everything).

```
browser ──https──> caddy ──/api/*──> api:4000 ──> postgres
                         └─ else ──> web:3000
```

## How a deploy runs

`.github/workflows/deploy-staging.yml` runs when CI passes on a push to `main` (or by hand:
Actions > Deploy staging > Run workflow, on `main` only and only for a commit CI passed on). CI
also builds the three images and validates the Compose file, Caddyfile and workflows on every pull
request, so deploy files are tested before they reach `main`. It:

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

Docker Engine and the Compose v2 plugin must already be installed. These steps do not install or
change Docker, and nothing here deletes or changes existing users, files or containers.

First check what is already there:

```sh
docker --version && docker compose version && docker ps
ss -tlnp | grep -E ':80 |:443 '
```

- All three Docker commands must succeed. `docker compose` (v2, with a space) is required; the old
  `docker-compose` is not enough.
- **Do not run the `get.docker.com` script on a server that already has Docker**, and never on a
  server shared with other projects. It reconfigures the apt repository and reinstalls packages,
  and if that fails the daemon stays down and every project's containers stop. If Docker or the
  Compose plugin is missing, install it the way the rest of the server was set up (for Ubuntu,
  Docker's apt repository: https://docs.docker.com/engine/install/ubuntu/), at a time when the
  other projects can take a restart.
- If something already listens on 80/443, follow "Behind an existing proxy" below.

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "PASTE THE CONTENT OF nolon-staging-deploy.pub HERE" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
```

Firewall (Hetzner Cloud Firewall or `ufw`):

- **80 and 443 (TCP) and 443 (UDP) open to everyone.** Let's Encrypt must reach port 80/443 to
  issue the certificate. Leave existing rules for your other projects as they are.
- **22 open to everyone, key-only.** GitHub-hosted runners have no fixed IP, so limiting SSH to
  your own IP breaks deploys. Turn off password login instead: in `/etc/ssh/sshd_config` set
  `PasswordAuthentication no`, then `systemctl reload ssh`.

### Sharing the server with other projects

The stack is isolated by its Compose project name `nolon-staging`: its containers, network and
volumes are all prefixed with it, and files live only in `~deploy/nolon-staging`. `deploy.sh`
removes only old NOLON images (label `com.nolon.stack=staging`), never other projects' images.
The only shared resources are ports 80/443 (see below) and the host's CPU, RAM and disk.

### Behind an existing proxy

If nginx, Caddy or Traefik already owns ports 80/443, set the repository variable
`STAGING_LOCAL_PORT` to a free local port, e.g. `8090` (it and the next port must be free:
`ss -tlnp | grep -E ':809[01] '` prints nothing). The
NOLON Caddy then listens only on `127.0.0.1:8090` (and `127.0.0.1:8091`, unused), serves plain
HTTP, and keeps doing the `/api` routing and basic auth. Your proxy terminates HTTPS for
`STAGING_DOMAIN` and forwards to it.

nginx: save as `/etc/nginx/sites-available/nolon-staging`, link it into `sites-enabled`, run
`nginx -t`, then `systemctl reload nginx` and `certbot --nginx -d staging.2-28-12-44.sslip.io` for
the certificate. Other sites are not touched.

```nginx
server {
    listen 80;
    server_name staging.2-28-12-44.sslip.io;
    location / {
        proxy_pass http://127.0.0.1:8090;
        client_max_body_size 25m;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy (certificate is automatic):

```caddyfile
staging.2-28-12-44.sslip.io {
	reverse_proxy 127.0.0.1:8090
}
```

### Docker group

Note: members of the `docker` group are effectively root on the server. The `deploy` user exists
so the key in GitHub can be revoked without touching root's access.

### 3. Host key (from the Hetzner Console only)

The host key pins the server so the deploy job cannot be tricked into talking to another machine.
It must come from a trusted channel: open **Hetzner Cloud Console > the server > Console** (the
web console, not an SSH session) and run:

```sh
cat /etc/ssh/ssh_host_ed25519_key.pub
```

Save that line (it starts with `ssh-ed25519`) as the `STAGING_SSH_KNOWN_HOSTS` secret.

If the secret already holds a key, verify it instead: in the same web console run
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, then on your PC save the secret's value to a
file and run `ssh-keygen -lf thatfile`. The two `SHA256:...` fingerprints must be identical.

Do not take the key from `ssh-keyscan` or from an SSH session alone: those go over the same
unverified network path the pin is meant to protect.

### 4. Basic auth password hash (required)

```sh
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'THE-PASSWORD-YOU-WILL-GIVE-THE-CLIENT'
```

The deploy refuses to run without both basic-auth secrets, so staging is never public by
accident. It also fails closed on the server: Caddy refuses to start unless `BASIC_AUTH` in `.env`
is exactly `on` (with a user and hash) or `off`, and the deploy's health check requires the page to
answer 401. `/api/v1/health` always stays open so the deploy job can check it.

To run staging public on purpose, set the repository variable `STAGING_ALLOW_PUBLIC` to `true`.
That alone turns basic auth off (the secrets can stay), and the health check then requires 200.
Delete the variable to make staging private again.

### 5. GitHub secrets

Settings > Secrets and variables > Actions > **Secrets** > New repository secret:

| Secret                        | Value                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `STAGING_SSH_HOST`            | Server IP, e.g. `2.28.12.44`                             |
| `STAGING_SSH_USER`            | `deploy`                                                 |
| `STAGING_SSH_PRIVATE_KEY`     | Full content of `nolon-staging-deploy` (the private key) |
| `STAGING_SSH_KNOWN_HOSTS`     | Output line of step 3                                    |
| `STAGING_POSTGRES_PASSWORD`   | Output of `openssl rand -hex 24` (letters/digits only)   |
| `STAGING_BASIC_AUTH_USER`     | e.g. `nolon`                                             |
| `STAGING_BASIC_AUTH_HASH`     | Output of step 4 (starts with `$2a$`)                    |
| `STAGING_SEED_ADMIN_EMAIL`    | Email of the first NOLON Administrator (required)        |
| `STAGING_SEED_ADMIN_PASSWORD` | At least 12 characters, no single quote `'`              |

The PostgreSQL password is set when the database volume is first created. Changing the secret
later does not change the database password; keep it stable.

The seed creates the Administrator only when no user has that email. Changing the secrets later
does not change an existing user or password; sign in and change it in the app.

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

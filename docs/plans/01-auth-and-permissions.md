# Plan: sign-in, roles, permissions and branch scoping

Source of truth: scope section 5 and annex A (permissions matrix). This is the base every business
module needs, because every query is branch-scoped (AGENTS.md rule 2).

## Decisions

| Topic            | Decision                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roles            | The 9 fixed roles of annex A, as a PostgreSQL enum. No custom role editor (scope section 5).                                                                                                                                    |
| Permissions      | A permission is `module:action` (e.g. `customers:create`, `invoices:approve`). The role to permissions map is code in `@nolon/shared`, a direct transcription of annex A, unit-tested cell by cell. Not stored in the database. |
| Multiple roles   | A user may hold several roles; their permissions add up (annex A).                                                                                                                                                              |
| Branch access    | Administrator and Management: every branch, through the role. Everyone else: only the branches in `user_branches`. Computed once per request into `allowedBranchIds`; services must filter on it.                               |
| Sessions         | Server-side sessions, not JWT. A random 32-byte token in a cookie; the database stores only its SHA-256. Cookie and CSRF rules: security requirement S2. Fewer than 15 users, so no scaling concern.                            |
| Password hashing | Node's built-in `crypto.scrypt` (no new dependency), per-user random salt, constant-time compare.                                                                                                                               |
| Session length   | 12 hours absolute, configurable by env (`SESSION_TTL_HOURS`).                                                                                                                                                                   |
| Brute force      | Same error for unknown email and wrong password. Attempt limits in memory (single API instance), keyed on the real client IP: security requirement S1.                                                                          |
| AI agent         | Not in this task. It will later get its own credentials and permissions through the Customer Service API.                                                                                                                       |

## Security requirements (acceptance criteria for step 2)

Each requirement below has integration tests in step 2; the PR is not done without them.

### S1. Client IP behind proxies

On staging a request passes the host nginx, then the Caddy container, then the API, so the API's
socket peer is always Caddy. Keying limits on that address would let one client's failed attempts
lock out every employee, and reading `X-Forwarded-For` by hand is spoofable.

- New env `TRUST_PROXY_HOPS` (integer, default `0`, validated in `config/env.ts`). `configureApp`
  sets Express `trust proxy` to exactly that number of hops, and the client IP is always
  `req.ip`, never a header read directly.
- Staging uses `2` (host nginx + Caddy). Caddy must append to `X-Forwarded-For` instead of
  replacing it, which needs `trusted_proxies` set to the host nginx address in the Caddyfile. That
  is a deploy-file change, made in its own PR coordinated with the deploy owner, not in the auth
  PR. Until it lands, every request reaches the API from the same nginx address, so staging runs
  with `LOGIN_IP_LIMIT_ENABLED=false` and only the per-email bucket applies. A shared IP therefore
  never locks everyone out.
- Limits: per email, 10 failed attempts in 15 minutes blocks that email for 15 minutes; per client
  IP, 50 failed attempts in 15 minutes. A success resets the email counter. The block is a delay,
  never a permanent lock.
- Tests: two different client IPs (via a trusted forwarding chain) get separate buckets; a client
  sending a forged `X-Forwarded-For` with extra entries is still keyed on the address the trusted
  hop saw; with `TRUST_PROXY_HOPS=0` the header is ignored.

### S2. Cookie scope and CSRF

`SameSite=Lax` alone is not enough: same-site sibling origins can still send credentialed requests,
and CORS does not stop simple form posts.

- Cookie name `__Host-nolon_session`, with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no
  `Domain` (host-only). Browsers treat `localhost` as secure, so the same cookie works in dev.
- Every unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) must carry an `Origin` header (or, if it is
  absent, a `Referer`) whose origin is in `CORS_ORIGINS` (plus the app's own origin). Otherwise
  the API answers `403` before the route runs. This applies to `/auth/login` too (login CSRF).
- Tests: a write with a foreign `Origin` is rejected with `403` even with a valid session cookie; a
  write with no `Origin` and no `Referer` is rejected; the same write from an allowed origin
  succeeds; the `Set-Cookie` header has exactly the attributes above.

### S3. Deactivation and revocation take effect at once

- The session guard loads the session together with its user on every authenticated request and
  rejects it when the session is expired or revoked, or when `users.is_active` is false. Roles and
  branches are also re-read per request, so a change applies to the next request.
- Deactivating a user also revokes all their open sessions.
- Tests: sign in while active, deactivate the user, then the same cookie gets `401` on `/auth/me`
  and on a protected route; the same for sign-out, an expired session, and a removed role or
  branch (`403` on the route that needed it).

## Database changes (this PR)

New migration `auth_users_roles_sessions`. Additive only: no drops, renames or type changes, no
NOT NULL added to an existing table.

- enum `role` (9 values)
- `users`: email (unique, CHECK lower-cased), full name, scrypt hash, preferred locale (CHECK ar/en), active flag, last sign-in
- `user_roles`: (user, role)
- `user_branches`: (user, branch), FK to `branches` with RESTRICT
- `sessions`: token hash (unique), expiry, revoked time, IP, user agent

Users are never hard-deleted; they are deactivated (`is_active = false`). The Driver rule "own trips
only" is a row-level filter that arrives with the transport module, not here.

## Steps (one PR each)

1. **This PR:** plan + schema + migration. No application code.
2. **API auth:** `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`; session guard on every route
   by default (public routes opt out with `@Public()`); `@RequirePermission('customers:view')`
   guard; a `CurrentUser` with `roles`, `permissions`, `allowedBranchIds`; a branch-scope helper
   that rejects a requested branch outside `allowedBranchIds`. Seed an admin user for staging from
   env (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, never committed). Unit + integration tests,
   including the negative cases: wrong password, inactive user, expired/revoked session, missing
   permission, branch not allowed, and every test listed under S1 to S3.
3. **Web sign-in page:** `/[locale]/login` (ar/en), sign-out, redirect to login when the session is
   missing. No permission logic in the web app; it shows what `/auth/me` returns.
4. **Users admin (Administrator only):** list/create/deactivate users, set roles and branches,
   reset password.

# Plan: sign-in, roles, permissions and branch scoping

Source of truth: scope section 5 and annex A (permissions matrix). This is the base every business
module needs, because every query is branch-scoped (AGENTS.md rule 2).

## Decisions

| Topic            | Decision                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roles            | The 9 fixed roles of annex A, as a PostgreSQL enum. No custom role editor (scope section 5).                                                                                                                                        |
| Permissions      | A permission is `module:action` (e.g. `customers:create`, `invoices:approve`). The role to permissions map is code in `@nolon/shared`, a direct transcription of annex A, unit-tested cell by cell. Not stored in the database.     |
| Multiple roles   | A user may hold several roles; their permissions add up (annex A).                                                                                                                                                                  |
| Branch access    | Administrator and Management: every branch, through the role. Everyone else: only the branches in `user_branches`. Computed once per request into `allowedBranchIds`; services must filter on it.                                   |
| Sessions         | Server-side sessions, not JWT. A random 32-byte token in an httpOnly, Secure, SameSite=Lax cookie; the database stores only its SHA-256. Sign-out and deactivation take effect at once. Fewer than 15 users, so no scaling concern. |
| Password hashing | Node's built-in `crypto.scrypt` (no new dependency), per-user random salt, constant-time compare.                                                                                                                                   |
| Session length   | 12 hours absolute, configurable by env (`SESSION_TTL_HOURS`).                                                                                                                                                                       |
| Brute force      | Same error for unknown email and wrong password. Simple per-email + per-IP attempt limit in memory (single API instance on staging).                                                                                                |
| AI agent         | Not in this task. It will later get its own credentials and permissions through the Customer Service API.                                                                                                                           |

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
   permission, branch not allowed.
3. **Web sign-in page:** `/[locale]/login` (ar/en), sign-out, redirect to login when the session is
   missing. No permission logic in the web app; it shows what `/auth/me` returns.
4. **Users admin (Administrator only):** list/create/deactivate users, set roles and branches,
   reset password.

# 10: The bookings agent admin panel item

Request from the agent project (2026-11-03): the owner and Shaker open the bookings agent's admin
panel from NOLON's menu and sign in there with their NOLON account, with no links or commands.

## What NOLON does

1. **Menu item** «إدارة وكيل الحجوزات» / "Bookings agent admin", at the foot of the menu above the
   account. It opens `AGENT_ADMIN_URL` in a new tab, exactly as the agent gives it
   (`<agent address>/agent-admin.html?tenant=nolon&signin=erp`). Empty: no item.
2. **Who sees it**: a new permission module `agent_admin` (the request's `agent.admin`; NOLON
   permissions are `module:action`, so it is `agent_admin:view`). Matrix: the Administrator holds
   `view`, nobody else by default; the owner gives it to anyone else on the permissions screen. It
   is a global module (no branch-owned rows), held when held in any branch. `/auth/me` gives
   `agentAdminUrl` only to holders, never to the assistant's own token. Hiding the item is not
   the security boundary: the panel admits only its own admins, by NOLON user id.
3. **Return address**: unchanged. The panel uses the same delegated sign-in (code + PKCE) and the
   same registered `redirect_uri` (`<agent address>/api/v1/auth/callback`) as the staff screen.
   Checked on staging 2026-11-03: every registered assistant client has that callback.

No database change: permissions are code defaults plus the permissions screen's rows.

## Deploy

Staging: repository variable `STAGING_AGENT_ADMIN_URL`. Production: off (`''`) until the agent
signs in against production; the code is the same on both.

## Agent compatibility

`/auth/me` gains one field; the agent reads `/auth/me` through an allowlist of fields, so it is
unaffected. No agent-readable route, draft or token changes.

## Owner steps

- Set `STAGING_AGENT_ADMIN_URL` and deploy.
- Permissions screen: give `agent_admin:view` to Mohamed and Shaker (the Administrator has it).
- Agent project: link the three NOLON user ids (in the thread's note) with `--erp-user`.
